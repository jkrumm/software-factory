#!/usr/bin/env bun
// The fake agw CLI the scenarios put on PATH as `agw`. Package 5 (quality) scripts the review reads; package 7 (loops and agw) fills in the workflows.
import { reviewCall } from './review.ts'
import { unscripted } from './fake.ts'

const args = process.argv.slice(2)
process.exitCode = reviewCall(args) ?? unscripted('agw', args)
