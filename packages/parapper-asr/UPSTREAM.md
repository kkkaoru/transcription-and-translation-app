# Upstream and license

This directory is a maintained source fork of
[Parakeet-Inc/Parapper-ASR](https://github.com/Parakeet-Inc/Parapper-ASR),
based on upstream commit `a01922f0383214e01a3875ec673fa1c316cdeb36`
(`v0.4.0-beta`, 2026-07-12).

The upstream MIT `LICENSE` is retained verbatim in this directory. Kotoba
Beacon-specific changes include Bun workspace commands and the bounded streaming
input behavior that drains queued audio gracefully after `session.stop`; its
regression test is `bounded_network_source_disconnects_gracefully_after_session_stop`.

Downloaded ASR model artifacts are runtime data and are intentionally not stored
in this source fork. Their license and distribution terms must be retained with
the selected model.
