FROM python:3.12-slim
ARG CACHEBUST=1
WORKDIR /app
COPY requirements.txt .
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr \
 && rm -rf /var/lib/apt/lists/* \
 && pip install -r requirements.txt --quiet
COPY . .
CMD ["python3", "poller.py"]
