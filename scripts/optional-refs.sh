#!/bin/bash
# Sourced by launch.sh and deploy.sh: the refs of .env.tpl that may be unresolved. The server starts without the token and the
# caller it names does not exist; every other ref must resolve, or the launch (exit 78) and the deploy (nothing changed) refuse.
# FACTORY_SIGNAL_TOKEN is Hermes' filing bearer: it is made at W14 of the cutover runbook, after the first deploy.
# shellcheck disable=SC2034 # read by the scripts that source this file
OPTIONAL_KEYS="FACTORY_SIGNAL_TOKEN"
