// Built from stdin: no host directory or credentials enter the Docker build context.
export const computerImage = (uid: number, gid: number) => `
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep python3 python3-pip python3-venv build-essential less procps tini && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex && npm cache clean --force
RUN mkdir -p /home/viber/.local/bin /home/viber/.local/lib /home/viber/data && chown -R ${uid}:${gid} /home/viber
ENV HOME=/home/viber USER=viber NPM_CONFIG_PREFIX=/home/viber/.local PATH=/home/viber/.local/bin:/usr/local/bin:/usr/bin:/bin
USER ${uid}:${gid}
WORKDIR /home/viber
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
`;
