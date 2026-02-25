"""Plugin registry -- auto-discovers Simulator plugins from a directory."""
from __future__ import annotations

import importlib
import inspect
import logging
import sys
from pathlib import Path

from workbench.api.simulator import Simulator

logger = logging.getLogger(__name__)


class PluginRegistry:
    """Discovers and manages Simulator plugins from a plugins directory.

    Each plugin is a Python package (directory with ``__init__.py``) that
    defines at least one concrete ``Simulator`` subclass.
    """

    def __init__(self, plugins_dir: Path | str) -> None:
        self.plugins_dir = Path(plugins_dir)
        self.simulators: dict[str, type[Simulator]] = {}

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def discover(self) -> None:
        """Scan *plugins_dir* for packages, import them, and register valid
        Simulator subclasses found inside."""
        if not self.plugins_dir.is_dir():
            logger.warning("Plugins directory does not exist: %s", self.plugins_dir)
            return

        # Temporarily add the plugins directory to sys.path so that
        # ``importlib.import_module`` can find the packages.
        plugins_str = str(self.plugins_dir)
        path_added = plugins_str not in sys.path
        if path_added:
            sys.path.insert(0, plugins_str)

        try:
            for entry in sorted(self.plugins_dir.iterdir()):
                if not entry.is_dir():
                    continue
                init_file = entry / "__init__.py"
                if not init_file.exists():
                    continue
                self._try_load_package(entry.name)
        finally:
            if path_added and plugins_str in sys.path:
                sys.path.remove(plugins_str)

    def _try_load_package(self, package_name: str) -> None:
        """Import *package_name* and register any valid Simulator subclasses."""
        try:
            # Remove from sys.modules cache so re-discovery works in tests.
            sys.modules.pop(package_name, None)
            module = importlib.import_module(package_name)
        except Exception:
            logger.exception("Failed to import plugin package '%s'", package_name)
            return

        for _attr_name, obj in inspect.getmembers(module, inspect.isclass):
            if obj is Simulator:
                continue
            if not issubclass(obj, Simulator):
                continue
            if inspect.isabstract(obj):
                continue
            self._validate_and_register(obj, package_name)

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def _validate_and_register(
        self, cls: type[Simulator], package_name: str
    ) -> None:
        """Validate that *cls* satisfies the plugin contract and register it."""
        # --- name ---
        name = getattr(cls, "name", None)
        if not name:
            logger.error(
                "Plugin class %s in package '%s' has no 'name' attribute -- skipping",
                cls.__name__,
                package_name,
            )
            return

        # --- api_version ---
        if not getattr(cls, "api_version", None):
            logger.error(
                "Plugin '%s' (%s) has no 'api_version' -- skipping",
                name,
                package_name,
            )
            return

        # --- config_schema ---
        try:
            schema = cls.config_schema()
            if not isinstance(schema, dict):
                raise TypeError(f"config_schema() returned {type(schema).__name__}, expected dict")
        except Exception:
            logger.exception(
                "Plugin '%s' (%s): config_schema() is invalid -- skipping",
                name,
                package_name,
            )
            return

        # --- policy_specs ---
        try:
            policies = cls.policy_specs()
            if not isinstance(policies, list) or len(policies) == 0:
                raise ValueError("policy_specs() must return a non-empty list")
        except Exception:
            logger.exception(
                "Plugin '%s' (%s): policy_specs() is invalid -- skipping",
                name,
                package_name,
            )
            return

        # All checks passed -- register.
        if name in self.simulators:
            logger.warning(
                "Duplicate simulator name '%s' -- overwriting previous registration",
                name,
            )
        self.simulators[name] = cls
        logger.info("Registered simulator plugin '%s' from package '%s'", name, package_name)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_simulator(self, name: str) -> Simulator | None:
        """Return a fresh instance of the named simulator, or ``None``."""
        cls = self.simulators.get(name)
        if cls is None:
            return None
        return cls()

    def list_simulators(self) -> list[dict]:
        """Return metadata for every registered simulator."""
        result: list[dict] = []
        for name, cls in self.simulators.items():
            result.append(
                {
                    "name": name,
                    "description": getattr(cls, "description", ""),
                    "api_version": getattr(cls, "api_version", ""),
                    "plugin_version": getattr(cls, "plugin_version", ""),
                    "policies": cls.policy_specs(),
                    "presets": list(cls.cluster_presets().keys()),
                }
            )
        return result
