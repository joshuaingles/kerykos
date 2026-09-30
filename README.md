# Kerykos

![CI](https://github.com/joshuaingles/kerykos/actions/workflows/ci.yml/badge.svg)

A companion app for [Hermes Agent](https://github.com/nousresearch/hermes-agent) on iOS and Android. Manage your self-hosted AI agent from your phone — chat, monitor sessions, track costs, and steer runs in real time.

## Features

- **Chat with your agent** — streaming messages via `/v1/runs` with full SSE support *(coming soon)*
- **Session management** — browse, search, rename, fork, and delete sessions *(coming soon)*
- **Cost tracking** — per-session cost display with on-device analytics (SQLite) *(coming soon)*
- **Image support** — send photos from your camera or library *(coming soon)*
- **Mid-run control** — steer active runs or stop them from your phone *(coming soon)*
- **Approval cards** — approve or deny agent actions requiring confirmation *(coming soon)*
- **Multi-gateway** — connect to multiple Hermes instances (data model ready, UI for 1 in v1) *(coming soon)*
- **Theming** — 9 skins with light/dark/system mode support *(coming soon)*

## Prerequisites

- A running [Hermes Agent](https://github.com/nousresearch/hermes-agent) instance with the API server enabled
- Your `API_SERVER_KEY` from `~/.hermes/.env`
- Node.js 22+ and npm
- For iOS: a Mac with Xcode (or use EAS Build)
- For Android: Android Studio with an emulator

## Getting Started

```bash
# Clone the repo
git clone https://github.com/joshuaingles/kerykos.git
cd kerykos

# Install dependencies
npm install

# Start the dev server
npx expo start
```

### Running on Android Emulator (Windows/Linux)

```bash
# Start the Android emulator first, then:
npx expo run:android
```

### Running on iOS Simulator (macOS)

```bash
npx expo run:ios
```

### Running on a Physical Device

Kerykos uses native modules (MMKV, SecureStore, SQLite, RevenueCat) and **does not work with Expo Go**. You need a development build:

```bash
# iOS (requires Mac + Xcode)
npx expo run:ios --device

# Android
npx expo run:android
```

Or use EAS Build for cloud builds:

```bash
# Install EAS CLI
npm install -g eas-cli

# Build for your device
eas build --profile development --platform ios
eas build --profile development --platform android
```

## Testing

```bash
# Run all tests
npx jest

# Run tests in CI mode
npx jest --ci

# Typecheck
npx tsc --noEmit

# Lint
npm run lint
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full technical design. Key decisions are documented in [docs/decisions.md](docs/decisions.md).

**Stack:** React Native (Expo SDK 57) · TypeScript 6 · Zustand · expo-sqlite · react-native-mmkv

**API surface:** REST + SSE against the Hermes API server on port 8642. See [docs/api-surface.md](docs/api-surface.md).

## Remote Access

Kerykos connects to your Hermes gateway via its API server. When your phone is on the same network, plain HTTP works. For remote access:

| Method | Encrypted | Setup |
|--------|-----------|-------|
| LAN (same Wi-Fi) | No | Zero config |
| [Tailscale](https://tailscale.com) | Yes (WireGuard) | ~5 min, free for ≤100 devices |
| HTTPS reverse proxy | Yes (TLS) | Domain + Caddy/nginx |

The app warns on unencrypted connections but never blocks them.

## License

Kerykos is licensed under the [Functional Source License 1.1](LICENSE.md) with Apache 2.0 as the Change License. The source code converts to Apache 2.0 on September 23, 2028.

## Acknowledgments

Built on [Hermes Agent](https://github.com/nousresearch/hermes-agent) by [Nous Research](https://nousresearch.com).