FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . /app

# Create runtime directories
RUN mkdir -p /app/workbench/data/events /app/data

EXPOSE 8000

# Use --factory since create_app() returns the app
CMD ["uvicorn", "workbench.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
