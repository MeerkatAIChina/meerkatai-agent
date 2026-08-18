FROM debian:bookworm-slim
ARG NODE_VERSION=v24.15.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl wget jq unzip xz-utils \
      python3 python3-pip python3-venv iptables \
    && pip3 install --break-system-packages --no-cache-dir pandas \
    && find /usr/local/lib/python3.11 -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find /usr/local/lib/python3.11 -type d -name "tests" -path "*site-packages*" -prune -exec rm -rf {} + \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
RUN curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 "node-${NODE_VERSION}-linux-x64/bin/node"
RUN useradd -r -s /usr/sbin/nologin sandbox
RUN mkdir -p /opt/qm
COPY aws/microvm-agent/agent.mjs /opt/qm/agent.mjs
COPY deploy/layers/meerkat/desktop/rootfs/egress-proxy.mjs /opt/qm/egress-proxy.mjs
COPY deploy/layers/meerkat/desktop/rootfs/egress-lock.sh /opt/qm/egress-lock.sh
ARG FINGERPRINT=dev
RUN echo "${FINGERPRINT}" > /etc/qm-sandbox-fingerprint
