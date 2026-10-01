# Extends the base test-agent image with common software pre-installed.
# Used by the common_software integration test to verify that all documented
# software in docs/common-software.mdx works correctly inside the sandbox.
#
# KEEP IN SYNC with docs/common-software.mdx

# BASE_IMAGE is required: the test passes the per-worktree sandbox-agent-test:<hash> tag.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      # Browsers
      chromium \
      firefox-esr \
      # Languages
      python3 python3-pip python3-venv \
      default-jdk \
      ruby-full \
      # Databases
      sqlite3 \
      redis-server \
      # Build tools
      build-essential cmake pkg-config \
      # CLI tools
      git jq tmux \
      # Media and graphics
      imagemagick \
      poppler-utils \
      # Desktop apps
      gimp \
      > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/local/bin/sandbox-agent"]
CMD ["server", "--host", "0.0.0.0", "--port", "3000", "--no-token"]
