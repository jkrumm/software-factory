#!/usr/bin/env bun
// The fake agw CLI the scenarios put on PATH as `agw`. Package 7 (loops and agw) fills in the workflows.
import { unscripted } from './fake.ts'

process.exitCode = unscripted('agw', process.argv.slice(2))
