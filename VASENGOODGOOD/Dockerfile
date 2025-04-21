# 使用 Ubuntu 22.04 作为基础镜像
FROM ubuntu:22.04

# 设置工作目录
WORKDIR /app

# 设置时区为上海
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 禁用所有代理设置
ENV no_proxy="*" \
    NO_PROXY="*" \
    http_proxy="" \
    https_proxy="" \
    HTTP_PROXY="" \
    HTTPS_PROXY="" \
    all_proxy="" \
    ALL_PROXY=""

# 使用阿里云镜像源
RUN sed -i 's/archive.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    apt-get clean && \
    apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    tesseract-ocr \
    poppler-utils \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 设置pip镜像源为阿里云
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/ && \
    pip config set install.trusted-host mirrors.aliyun.com

# 复制依赖文件
COPY requirements.txt .

# 安装Python依赖
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY . .

# 创建必要的目录
RUN mkdir -p uploads/csv uploads/photos uploads/passports uploads/cache logs

# 设置环境变量
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FLASK_APP=backend/app.py

# 设置权限
RUN chmod -R 755 /app

# 暴露端口
EXPOSE 5000

# 启动命令
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "--timeout", "300", "backend.app:app"] 