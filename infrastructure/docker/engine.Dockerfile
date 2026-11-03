# syntax=docker/dockerfile:1
# Matching engine image. Build context: repository root.
ARG RUST_IMAGE=rust:1.97.0-slim-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${RUST_IMAGE} AS build
WORKDIR /src
# Dependency layer first (cached unless Cargo.toml/Cargo.lock change).
COPY services/matching-engine/Cargo.toml services/matching-engine/Cargo.lock services/matching-engine/rust-toolchain.toml ./
RUN mkdir -p src/bin && echo 'fn main() {}' > src/bin/engine-server.rs && echo '' > src/lib.rs \
 && cargo build --release --locked --bin engine-server && rm -rf src
COPY services/matching-engine/src ./src
RUN touch src/lib.rs src/bin/engine-server.rs && cargo build --release --locked --bin engine-server

FROM ${RUNTIME_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system app && useradd --system --gid app --no-create-home app
COPY --from=build --chown=root:root /src/target/release/engine-server /usr/local/bin/engine-server
USER app
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/engine-server"]
