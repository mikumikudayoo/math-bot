FROM python:3.12-slim
RUN useradd --uid 10001 --no-create-home sandbox
USER 10001:10001
WORKDIR /tmp
CMD ["python", "-I", "-B", "-"]
