FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY src/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && useradd -u 10001 -m appuser && mkdir /data && chown appuser:appuser /data
COPY src/app.py ./app.py
COPY src/mouser_import.py ./mouser_import.py
COPY src/tracking_worker.py ./tracking_worker.py
COPY src/templates ./templates
COPY src/static ./static
USER appuser
EXPOSE 8000
CMD ["gunicorn", "--workers", "1", "--threads", "4", "--bind", "0.0.0.0:8000", "app:app"]
