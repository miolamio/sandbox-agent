FROM rust:1.88.0-bookworm AS builder
WORKDIR /build

# Cargo.lock is gitignored, so a fresh worktree may not have one. The glob
# keeps the COPY valid either way; without a lock, cargo resolves one in the
# build and the resolver env below picks versions that build on this rustc.
COPY Cargo.toml Cargo.lock* ./
COPY server/ ./server/
COPY gigacode/ ./gigacode/
COPY resources/agent-schemas/artifacts/ ./resources/agent-schemas/artifacts/
COPY scripts/agent-configs/ ./scripts/agent-configs/
COPY scripts/audit-acp-deps/ ./scripts/audit-acp-deps/

ENV SANDBOX_AGENT_SKIP_INSPECTOR=1
ENV CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback

# The target cache is shared by every checkout (worktrees included). Cargo
# decides freshness of workspace crates by mtime, and COPY keeps host mtimes,
# so a checkout whose sources are older than another checkout's cached
# artifacts would silently link stale crates. Touching the sources first makes
# every workspace crate rebuild (dependencies stay cached); sharing=locked
# serializes concurrent builds so one cannot swap target/ under another.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=sandbox-agent-test-target,sharing=locked,target=/build/target \
    find . -path ./target -prune -o -type f -exec touch {} + && \
    cargo build -p sandbox-agent --release && \
    cp target/release/sandbox-agent /sandbox-agent

# Extract neko binary from the official image for WebRTC desktop streaming.
# Using neko v3 base image from GHCR which provides multi-arch support (amd64, arm64).
# Pinned by digest to prevent breaking changes from upstream.
# Reference client: https://github.com/demodesk/neko-client/blob/37f93eae6bd55b333c94bd009d7f2b079075a026/src/component/internal/webrtc.ts
FROM ghcr.io/m1k1o/neko/base@sha256:0c384afa56268aaa2d5570211d284763d0840dcdd1a7d9a24be3081d94d3dfce AS neko-base

FROM node:22-bookworm-slim
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      ca-certificates \
      bash \
      libstdc++6 \
      xvfb \
      openbox \
      xdotool \
      imagemagick \
      ffmpeg \
      gstreamer1.0-tools \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-ugly \
      gstreamer1.0-nice \
      gstreamer1.0-x \
      gstreamer1.0-pulseaudio \
      libxcvt0 \
      x11-xserver-utils \
      dbus-x11 \
      xauth \
      fonts-dejavu-core \
      xterm \
      > /dev/null 2>&1 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /sandbox-agent /usr/local/bin/sandbox-agent
COPY --from=neko-base /usr/bin/neko /usr/local/bin/neko

EXPOSE 3000
# Expose UDP port range for WebRTC media transport
EXPOSE 59050-59070/udp

ENTRYPOINT ["/usr/local/bin/sandbox-agent"]
CMD ["server", "--host", "0.0.0.0", "--port", "3000", "--no-token"]
