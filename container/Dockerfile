FROM node:20-slim

# Install OpenCode CLI
RUN npm install -g @opencode-ai/opencode

# Install basic utilities for agent tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ripgrep \
    jq \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user for agent execution
RUN useradd -m -s /bin/bash agent

# Working directory (will be overridden by volume mount)
WORKDIR /work

# Default to running as the agent user
USER agent

# Default entrypoint — the container-runner overrides the command
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["echo 'NanoClaw agent container ready'"]
