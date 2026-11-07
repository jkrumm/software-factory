#!/usr/bin/env bun
// The fake herdr-core CLI the scenarios put on PATH as `hc`. Package 4 (leads) fills in the verbs the runner uses.
import { unscripted } from './fake.ts'

process.exitCode = unscripted('hc', process.argv.slice(2))
