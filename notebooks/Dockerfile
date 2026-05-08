FROM python:3.12-slim

WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    git \
    curl \
    unzip \
    groff \
    less \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (arch-aware for ARM64/x86_64)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then \
      curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
      curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /root/.jupyter

COPY jupyter_lab_config.py /root/.jupyter/

EXPOSE 8888

ENV JUPYTER_ENABLE_LAB=yes \
    JUPYTER_CONFIG_DIR=/root/.jupyter

CMD ["jupyter", "lab", "--config=/root/.jupyter/jupyter_lab_config.py"]
