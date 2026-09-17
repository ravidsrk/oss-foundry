# Witness run logs

Wave 0 `evidence` writes `docs/evidence/logs/<packetId>/{test,revert}.log` here so the sha256 on the evidence page is recomputable (`shasum -a 256` of these two files).

This directory is empty until a packet is witnessed. Do not invent log files. The first real Wave 0 witness (issue #138 / H-03) creates the per-packet subdirectories.
