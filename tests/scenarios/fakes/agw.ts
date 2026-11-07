#!/usr/bin/env bun
// The fake agw CLI the scenarios put on PATH as `agw`. Package 7 (loops and agw) fills in the other workflows.
import { askFake } from './agw-ask.ts'
import { unscripted } from './fake.ts'

const args = process.argv.slice(2)
process.exitCode = args[0] === 'factory-ask' ? await askFake(args) : unscripted('agw', args)
