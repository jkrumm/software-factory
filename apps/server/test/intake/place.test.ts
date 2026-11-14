import { describe, expect, test } from 'bun:test'
import { placeByName } from '../../src/domains/intake/place.ts'

const projects = ['vps', 'weather-orb', 'homelab', 'software-factory', 'factory-ui']

describe('placeByName', () => {
  test('a project name is a run of the monitor words, separators ignored', () => {
    expect(placeByName('WeatherOrb Watchdog', projects)).toBe('weather-orb')
    expect(placeByName('weather orb - Push', projects)).toBe('weather-orb')
    expect(placeByName('homelab Immich ML - Docker', projects)).toBe('homelab')
  })

  test('a name too short to mean something, a miss and a tie place nothing', () => {
    expect(placeByName('vps edge 5xx rate', projects)).toBeNull()
    expect(placeByName('MacMini Drift - Push', projects)).toBeNull()
    expect(placeByName('software factory', ['software-factory', 'software--factory'])).toBeNull()
  })

  test('the longest matching project wins', () => {
    expect(placeByName('factory ui heartbeat', ['factory', 'factory-ui'])).toBe('factory-ui')
  })
})
