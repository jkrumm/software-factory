#!/usr/bin/env bun
// The fake agw CLI the scenarios put on PATH as `agw`: the Judge (`factory-ask`), the steward and triage workflows, `run wait`,
// and, from package 5, the review reads.
import { askFake } from './agw-ask.ts'
import { runWait } from './agw-envelope.ts'
import { loopsFake } from './agw-loops.ts'
import { unscripted } from './fake.ts'
import { reviewCall } from './review.ts'

const args = process.argv.slice(2)
const workflow = args[0]
process.exitCode =
  workflow === 'factory-ask'
    ? await askFake(args)
    : workflow === 'factory-steward' ||
        workflow === 'factory-triage' ||
        workflow === 'factory-queue' ||
        workflow === 'factory-hygiene' ||
        workflow === 'factory-fix-classes' ||
        workflow === 'factory-screen' ||
        workflow === 'factory-errand' ||
        workflow === 'factory-spec-screen' ||
        (workflow === 'factory' && args[1] === 'digest')
      ? await loopsFake(args)
      : workflow === 'run' && args[1] === 'wait'
        ? runWait(args)
        : (reviewCall(args) ?? unscripted('agw', args))
