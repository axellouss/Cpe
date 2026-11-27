#!/usr/bin/env bash
# GitHub code search for any open-source trace of LuxEeB-Tool integrations.
# Works in the sandbox with the preconfigured `gh` (2.89). Code search is rate-limited: keep the sleep.
for q in '"LuxEeB-Tool"' '"LuxEeB-H"' '"LuxEeB_H"' '"LuxEeB-F"' '"energyefficient.lu"' '"luxeeb"' '"Energiepass" Luxembourg' '"lesosai" bld'; do
  printf '%s\t' "$q"
  gh api -X GET search/code -f q="$q" -f per_page=1 --jq '.total_count' 2>&1
  sleep 7
done
