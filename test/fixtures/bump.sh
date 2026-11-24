#!/usr/bin/env bash
# Stands in for a collection's bump command in ci.yml's dry run.
set -euo pipefail
echo "$1" > "bumped-$1.txt"
echo "$1: 0 -> 1"
