# Changelog

## 0.1.2 - 2026-09-25

First fully-packaged release.

### Added

- Version footer at the bottom of the plugin page.
- Kubeconfig discovery chain covering common OpenShift layouts.
- Panel visibility menu (three-dot button) with persisted preferences.
- Auto-hide for Lightspeed and Tailscale panels when absent.
- RPM packaging (spec + Makefile target).

### Fixed

- Footer version reads from `manifest.json` instead of a placeholder.
- Prometheus pod resolved by label, not hardcoded name.
- Tailscale panel reports advertised routes dynamically.
