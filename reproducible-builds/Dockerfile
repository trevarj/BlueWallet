# Base image and Debian package repository are fixed independently of Nix inputs.
FROM node:24-bullseye-slim@sha256:e27057f6adaf0b3f172345fb5cdca821e07203ca81bc35f7b0a9e9631b255340

ENV TZ=UTC \
    LANG=C \
    LC_ALL=C \
    SOURCE_DATE_EPOCH=315532800

RUN printf '%s\n' \
    'deb http://snapshot.debian.org/archive/debian/20260524T000000Z bullseye main contrib non-free' \
    'deb http://snapshot.debian.org/archive/debian-security/20260524T000000Z bullseye-security main contrib non-free' \
    > /etc/apt/sources.list \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot \
    && echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /nix /app \
    && chown node:node /nix /app

USER node
RUN curl -fsS https://releases.nixos.org/nix/nix-2.31.2/nix-2.31.2-x86_64-linux.tar.xz -o /tmp/nix.tar.xz \
    && echo "d1f67c86eed016214864ba08bfb9529c307aea7e8fafb74853f96fcc3bfd8a60 /tmp/nix.tar.xz" | sha256sum --check \
    && tar -xJf /tmp/nix.tar.xz -C /tmp \
    && /tmp/nix-2.31.2-x86_64-linux/install --no-daemon --yes \
    && mkdir -p /home/node/.config/nix \
    && printf '%s\n' 'sandbox = false' >> /home/node/.config/nix/nix.conf \
    && rm -rf /tmp/nix.tar.xz /tmp/nix-2.31.2-x86_64-linux

ENV PATH=/home/node/.nix-profile/bin:$PATH \
    NIX_CONFIG="experimental-features = nix-command flakes"

WORKDIR /app
COPY --chown=node:node . /app
