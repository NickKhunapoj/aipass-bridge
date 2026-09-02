FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies, Xvfb, Fluxbox, VNC, noVNC, Supervisor, and Thai fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    procps \
    net-tools \
    dbus-x11 \
    fonts-liberation \
    fonts-thai-tlwg \
    fonts-noto-color-emoji \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ensure noVNC has an index.html pointing to vnc.html
RUN if [ -f /usr/share/novnc/vnc.html ] && [ ! -f /usr/share/novnc/index.html ]; then \
        ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html; \
    fi

EXPOSE 6080 8787 9222

ENV DISPLAY=:99 \
    AIPASS_PORT=8787 \
    AIPASS_HOST=0.0.0.0 \
    AIPASS_MODEL=gemini-3.1-flash-lite

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY start-browser.sh /app/start-browser.sh
COPY start-vnc.sh /app/start-vnc.sh
RUN chmod +x /app/start-browser.sh /app/start-vnc.sh 2>/dev/null || true

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
