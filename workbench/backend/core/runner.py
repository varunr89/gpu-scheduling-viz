"""Experiment runner -- executes simulations in worker processes and streams events.

Uses ProcessPoolExecutor for CPU-intensive simulation work and
multiprocessing.Manager for cross-process Queue/Event objects.
"""

from __future__ import annotations

import asyncio
import json
import logging
import multiprocessing
import traceback
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from queue import Empty
from typing import AsyncIterator, Dict, Optional, Union

from workbench.api.simulator import Simulator
from workbench.api.types import (
    CompleteEvent,
    ErrorEvent,
    ExperimentEvent,
    RoundEvent,
)

logger = logging.getLogger(__name__)

# Sentinel placed on the queue to signal that the worker process has finished.
_SENTINEL = "__DONE__"

# Number of RoundEvents per chunked JSONL file.
_CHUNK_SIZE = 1000


def _worker_fn(
    simulator: Simulator,
    config: dict,
    event_queue: multiprocessing.Queue,
    cancel_event: multiprocessing.Event,
) -> None:
    """Top-level function that runs inside a worker process.

    Calls simulator.run(), catches any exception and emits an ErrorEvent,
    then always places a sentinel on the queue so the consumer knows
    the worker is done.
    """
    try:
        simulator.run(config, event_queue, cancel_event)
    except Exception:
        tb = traceback.format_exc()
        event_queue.put(ErrorEvent(message="Simulation failed", traceback=tb))
    finally:
        event_queue.put(_SENTINEL)


class ExperimentRunner:
    """Runs simulator experiments in separate processes and yields events."""

    def __init__(
        self,
        max_workers: int = 2,
        data_dir: Optional[Union[str, Path]] = None,
    ) -> None:
        self._max_workers = max_workers
        self._data_dir = Path(data_dir) if data_dir is not None else None
        self._manager: Optional[multiprocessing.managers.SyncManager] = None
        self._pool: Optional[ProcessPoolExecutor] = None
        # Track cancel events keyed by experiment_id so callers can cancel.
        self._cancel_events: Dict[str, multiprocessing.Event] = {}

    # ------------------------------------------------------------------
    # Lazy initialisation
    # ------------------------------------------------------------------

    def _ensure_started(self) -> None:
        if self._manager is None:
            self._manager = multiprocessing.Manager()
        if self._pool is None:
            self._pool = ProcessPoolExecutor(max_workers=self._max_workers)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def run_experiment(
        self,
        experiment_id: str,
        simulator: Simulator,
        config: dict,
    ) -> AsyncIterator[ExperimentEvent]:
        """Async generator that yields ExperimentEvent objects as they arrive.

        Events are also persisted to chunked JSONL files under
        ``data_dir/events/{experiment_id}/``.
        """
        self._ensure_started()

        event_queue = self._manager.Queue()
        cancel_event = self._manager.Event()
        self._cancel_events[experiment_id] = cancel_event

        # Prepare on-disk event directory.
        events_dir: Optional[Path] = None
        if self._data_dir is not None:
            events_dir = self._data_dir / "events" / experiment_id
            events_dir.mkdir(parents=True, exist_ok=True)

        # Submit the worker.
        future = self._pool.submit(
            _worker_fn, simulator, config, event_queue, cancel_event
        )

        loop = asyncio.get_event_loop()

        # Chunked JSONL writer state.
        round_buffer: list[dict] = []
        chunk_index = 0

        def _flush_rounds() -> int:
            """Write buffered round events to a JSONL chunk file.

            Returns the next chunk_index to use.
            """
            nonlocal chunk_index
            if not round_buffer or events_dir is None:
                round_buffer.clear()
                return chunk_index
            path = events_dir / f"rounds_{chunk_index:04d}.jsonl"
            with open(path, "a") as f:
                for rd in round_buffer:
                    f.write(json.dumps(rd) + "\n")
            round_buffer.clear()
            chunk_index += 1
            return chunk_index

        try:
            while True:
                # Poll the queue from the asyncio event loop without blocking.
                try:
                    event = await loop.run_in_executor(
                        None, lambda: event_queue.get(timeout=0.1)
                    )
                except Empty:
                    # If the worker process has finished and queue is empty,
                    # we are done.
                    if future.done():
                        # Drain any remaining items that arrived between the
                        # timeout and the done-check.
                        while True:
                            try:
                                event = event_queue.get_nowait()
                            except Empty:
                                break
                            if event is _SENTINEL or event == _SENTINEL:
                                continue
                            yield event
                            if isinstance(event, RoundEvent):
                                round_buffer.append(event.to_dict())
                                if len(round_buffer) >= _CHUNK_SIZE:
                                    _flush_rounds()
                            elif isinstance(event, (CompleteEvent, ErrorEvent)):
                                self._write_terminal_event(events_dir, event)
                        # If the future raised (e.g. pickling error), emit
                        # an ErrorEvent so the caller always gets notified.
                        exc = future.exception()
                        if exc is not None:
                            err = ErrorEvent(
                                message=str(exc),
                                traceback=None,
                            )
                            yield err
                            self._write_terminal_event(events_dir, err)
                        break
                    continue

                # Sentinel means worker is done -- drain and exit.
                if event is _SENTINEL or event == _SENTINEL:
                    # Drain remaining events (should be none, but be safe).
                    while True:
                        try:
                            leftover = event_queue.get_nowait()
                        except Empty:
                            break
                        if leftover is _SENTINEL or leftover == _SENTINEL:
                            continue
                        yield leftover
                        if isinstance(leftover, RoundEvent):
                            round_buffer.append(leftover.to_dict())
                            if len(round_buffer) >= _CHUNK_SIZE:
                                _flush_rounds()
                        elif isinstance(leftover, (CompleteEvent, ErrorEvent)):
                            self._write_terminal_event(events_dir, leftover)
                    break

                yield event

                # Persist to disk.
                if isinstance(event, RoundEvent):
                    round_buffer.append(event.to_dict())
                    if len(round_buffer) >= _CHUNK_SIZE:
                        _flush_rounds()
                elif isinstance(event, (CompleteEvent, ErrorEvent)):
                    self._write_terminal_event(events_dir, event)
        finally:
            # Flush any remaining rounds.
            _flush_rounds()
            # Clean up cancel event tracking.
            self._cancel_events.pop(experiment_id, None)

    async def run_group(
        self,
        group_id: str,
        experiments: list,
        simulator: Simulator,
    ) -> AsyncIterator[dict]:
        """Run multiple experiments sequentially and yield tagged events.

        Each experiment in *experiments* should be a dict with ``"id"`` and
        ``"config"`` keys.  Events are wrapped in a dict with ``type``,
        ``experiment_idx``, ``experiment_id``, and ``data`` fields so the
        caller can demux by experiment.

        After all experiments finish (or error), a final
        ``{"type": "group_complete"}`` event is yielded.
        """
        for idx, exp in enumerate(experiments):
            async for event in self.run_experiment(
                exp["id"], simulator, exp["config"]
            ):
                if isinstance(event, RoundEvent):
                    yield {
                        "type": "round",
                        "experiment_idx": idx,
                        "experiment_id": exp["id"],
                        "data": event.to_dict(),
                    }
                elif isinstance(event, CompleteEvent):
                    yield {
                        "type": "complete",
                        "experiment_idx": idx,
                        "experiment_id": exp["id"],
                        "data": event.to_dict(),
                    }
                elif isinstance(event, ErrorEvent):
                    yield {
                        "type": "error",
                        "experiment_idx": idx,
                        "experiment_id": exp["id"],
                        "data": event.to_dict(),
                    }
        yield {"type": "group_complete"}

    def cancel_experiment(self, experiment_id: str) -> bool:
        """Signal a running experiment to cancel.

        Returns True if the experiment was found and signalled, False otherwise.
        """
        cancel_event = self._cancel_events.get(experiment_id)
        if cancel_event is not None:
            cancel_event.set()
            return True
        return False

    async def shutdown(self) -> None:
        """Shut down the process pool and manager."""
        if self._pool is not None:
            self._pool.shutdown(wait=True)
            self._pool = None
        if self._manager is not None:
            self._manager.shutdown()
            self._manager = None
        self._cancel_events.clear()

    # ------------------------------------------------------------------
    # Disk persistence helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _write_terminal_event(
        events_dir: Optional[Path],
        event: Union[CompleteEvent, ErrorEvent],
    ) -> None:
        """Write a CompleteEvent or ErrorEvent to its own JSON file."""
        if events_dir is None:
            return
        if isinstance(event, CompleteEvent):
            path = events_dir / "complete.json"
        else:
            path = events_dir / "error.json"
        with open(path, "w") as f:
            json.dump(event.to_dict(), f)
