#!/usr/bin/env bash
#
# Register the two containers as Proxmox HA resources.
# Run on ANY node of the cluster, AFTER the containers exist and are working.
#
# What this gives you:
#   - If the node a container runs on dies, the HA manager fences it and
#     restarts the container on a surviving node (your "brief restart").
#   - For PLANNED maintenance you still migrate manually first (see README),
#     then patch the now-empty node.
#
# Requirements (already true on your setup):
#   - The containers' disks are on shared storage (Ceph).
#   - The cluster has quorum. With 4 nodes you keep quorum with 1 node down,
#     so single-node maintenance / single-node failure is always safe.
set -euo pipefail

APP_ID=5000
DB_ID=5010

# --state started  : HA keeps the container running (restart/relocate on failure)
# --max_restart    : restart attempts on the same node before relocating
# --max_relocate   : relocate attempts to other nodes
ha-manager add "ct:${DB_ID}"  --state started --max_restart 3 --max_relocate 3
ha-manager add "ct:${APP_ID}" --state started --max_restart 3 --max_relocate 3

echo
echo "HA resources added. Inspect with:"
echo "  ha-manager status"
echo "  ha-manager config"
