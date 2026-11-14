#!/usr/bin/env bash
# Run a dev Home Assistant from the local venv on http://localhost:8124
# (user: dev / password: dev). First run seeds ha_config/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
HASS="$ROOT/.venv/bin/hass"
CFG="$ROOT/ha_config"
export RADAR_SIM_DATA="$ROOT/dev/data"

if [ ! -f "$CFG/configuration.yaml" ]; then
  mkdir -p "$CFG/custom_components" "$CFG/.storage"
  cp dev/configuration.yaml "$CFG/configuration.yaml"
  "$HASS" --script auth -c "$CFG" add dev dev
  cat > "$CFG/.storage/onboarding" <<'JSON'
{"version": 4, "minor_version": 1, "key": "onboarding",
 "data": {"done": ["user", "core_config", "analytics", "integration"]}}
JSON
fi
ln -sfn "$ROOT/custom_components/radar_zone_presence" "$CFG/custom_components/radar_zone_presence"
ln -sfn "$ROOT/dev/radar_sim" "$CFG/custom_components/radar_sim"
exec "$HASS" -c "$CFG" "$@"
