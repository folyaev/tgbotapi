# utmanager/Dockerfile
FROM python:3.12-slim
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONIOENCODING=UTF-8 \
    PYTHONUTF8=1
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# ВАЖНО: запускаем пакет, а не старый UTManagerBot.py
CMD ["python", "-m", "utmanager"]
