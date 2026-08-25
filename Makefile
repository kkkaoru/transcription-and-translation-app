.DEFAULT_GOAL := help

PARAPPER_MANIFEST := packages/parapper-asr/Cargo.toml

.PHONY: help parapper-fetch parapper-check

help:
	@printf '%s\n' \
		'Kotoba Beacon development targets:' \
		'  make parapper-fetch  Fetch locked Parapper Rust dependencies once' \
		'  make parapper-check  Check Parapper with locked, offline dependencies'

# Run once after Cargo.lock changes or on a machine without the locked dependencies.
parapper-fetch:
	cargo fetch --locked --manifest-path $(PARAPPER_MANIFEST)

# Offline mode avoids Cargo package-cache/network stalls during repeat validation.
parapper-check:
	cargo check --locked --offline --manifest-path $(PARAPPER_MANIFEST) -p parapper
