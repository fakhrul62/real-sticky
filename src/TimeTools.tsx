import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { AlarmClock, ArrowUpRight, ChevronDown, Clock3, Globe2, Pause, Play, RotateCcw, Timer, Hourglass } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { IconButton, Menu, MenuItem } from './ui'
import { desktop } from './notes'

export const timeNames = { clock: 'Clock', timer: 'Timer', stopwatch: 'Stopwatch' } as const
export type TimeMode = keyof typeof timeNames
type Countdown = { duration: number; remaining: number; endsAt: number | null }
type Stopwatch = { elapsed: number; startedAt: number | null }

const zones = [
  ['Local time', undefined],
  ['Dhaka', 'Asia/Dhaka'],
  ['London', 'Europe/London'],
  ['New York', 'America/New_York'],
  ['Tokyo', 'Asia/Tokyo'],
  ['UTC', 'UTC'],
] as const

const defaultCountdown = { duration: 25 * 60000, remaining: 25 * 60000, endsAt: null }
const defaultStopwatch = { elapsed: 0, startedAt: null }

function useStored<T,>(name: string, fallback: T) {
  const key = `real-sticky-time-${name}`
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved ? JSON.parse(saved) : fallback
    } catch {
      return fallback
    }
  })
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== key) return
      try { setValue(event.newValue ? JSON.parse(event.newValue) : fallback) } catch { /* Ignore invalid stored values. */ }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [key, fallback])
  const update = useCallback((next: T) => {
    setValue(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* Time tools still work in memory. */ }
  }, [key])
  return [value, update] as const
}

function durationText(milliseconds: number, round: (seconds: number) => number, showHours = false) {
  const seconds = round(Math.max(0, milliseconds) / 1000)
  const minutes = Math.floor(seconds / 60)
  if (showHours || minutes >= 60) {
    return [Math.floor(minutes / 60), minutes % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':')
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function chime() {
  try {
    const context = new AudioContext()
    const tone = context.createOscillator()
    const volume = context.createGain()
    tone.frequency.value = 740
    volume.gain.setValueAtTime(0.1, context.currentTime)
    volume.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.55)
    tone.connect(volume).connect(context.destination)
    tone.start()
    tone.stop(context.currentTime + 0.6)
    tone.onended = () => { void context.close() }
  } catch { /* Completion is also visible on the timer. */ }
}

function scheduleNotification(endsAt: number | null) {
  if (desktop) void invoke('schedule_countdown', { endsAt }).catch(() => {})
}

export function TimeTools({ fixedMode, windowControls, onError }: {
  fixedMode?: TimeMode
  windowControls?: ReactNode
  onError?: (reason: unknown) => void
}) {
  const [workspaceMode, setMode] = useStored<TimeMode>('mode', 'clock')
  const mode = fixedMode ?? workspaceMode
  const [zoneIndex, setZoneIndex] = useStored('zone', 0)
  const [countdown, setCountdown] = useStored<Countdown>('countdown', defaultCountdown)
  const [initialDeadline] = useState(countdown.endsAt)
  const [stopwatch, setStopwatch] = useStored<Stopwatch>('stopwatch', defaultStopwatch)
  const [now, setNow] = useState(Date.now)
  const [durationOpen, setDurationOpen] = useState(false)
  const running = countdown.endsAt !== null
  const remaining = running ? Math.max(0, countdown.endsAt! - now) : countdown.remaining
  const finished = !running && remaining === 0
  const elapsed = stopwatch.elapsed + (stopwatch.startedAt ? Math.max(0, now - stopwatch.startedAt) : 0)
  const [zoneName, timeZone] = zones[zoneIndex] ?? zones[0]

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 200)
    const refresh = () => setNow(Date.now())
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  useEffect(() => {
    if (countdown.endsAt === null || now < countdown.endsAt) return
    setCountdown({ ...countdown, remaining: 0, endsAt: null })
    if (!desktop) chime()
  }, [now, countdown, setCountdown])

  useEffect(() => {
    if (initialDeadline !== null) scheduleNotification(initialDeadline)
  }, [initialDeadline])

  function configure(value: number) {
    const duration = Math.round(value * 60000)
    scheduleNotification(null)
    setCountdown({ duration, remaining: duration, endsAt: null })
  }

  function toggleTimer() {
    if (running) {
      scheduleNotification(null)
      setCountdown({ ...countdown, endsAt: null, remaining: Math.max(0, countdown.endsAt! - Date.now()) })
      return
    }
    const date = Date.now()
    setNow(date)
    const endsAt = date + (countdown.remaining || countdown.duration)
    scheduleNotification(endsAt)
    setCountdown({ ...countdown, endsAt })
  }

  function toggleStopwatch() {
    const date = Date.now()
    setNow(date)
    setStopwatch(stopwatch.startedAt
      ? { elapsed: stopwatch.elapsed + Math.max(0, date - stopwatch.startedAt), startedAt: null }
      : { ...stopwatch, startedAt: date })
  }

  const clockFormat = useMemo(() => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), [timeZone])
  const dateFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }), [timeZone])

  async function openFloatingTool() {
    if (desktop) await invoke('float_time', { mode })
    else window.open(`#time=${mode}`, `time-${mode}`, 'width=285,height=145,popup')
  }

  return (
    <section className={`time-card ${fixedMode ? 'time-card-floating' : ''}`} aria-label={fixedMode ? timeNames[mode] : 'Time tools'}>
      <div className="time-head" data-tauri-drag-region={fixedMode ? '' : undefined}>
        {fixedMode ? <h1 data-tauri-drag-region>{timeNames[mode]}</h1> : <span>{timeNames[mode]}</span>}
        {fixedMode ? windowControls : (
          <div className="time-head-actions">
            <div className="time-switch" role="group" aria-label="Time mode">
              <IconButton label="Clock" selected={mode === 'clock'} onClick={() => setMode('clock')}><Clock3 /></IconButton>
              <IconButton label="Timer" selected={mode === 'timer'} onClick={() => setMode('timer')}><Hourglass />{running && <i />}</IconButton>
              <IconButton label="Stopwatch" selected={mode === 'stopwatch'} onClick={() => setMode('stopwatch')}><Timer /></IconButton>
            </div>
            <IconButton label={`Float ${mode}`} className="float-time-button" onClick={() => void openFloatingTool().catch(reason => onError?.(reason))}><ArrowUpRight /></IconButton>
          </div>
        )}
      </div>
      {mode === 'clock' ? (
        <>
          <div className="time-digits">{clockFormat.format(now)}</div>
          <div className="time-bottom">
            <span>{dateFormat.format(now)}</span>
            <Menu trigger={<button type="button" className="zone-button" aria-label={`Change time zone: ${zoneName}`}><Globe2 />{zoneName}<ChevronDown /></button>}>
              {zones.map(([name], index) => (
                <MenuItem key={name} checked={zoneIndex === index} onSelect={() => setZoneIndex(index)}>{name}</MenuItem>
              ))}
            </Menu>
          </div>
        </>
      ) : (
        <>
          <div className="time-readout">
            <div className="time-digits">{mode === 'timer' ? durationText(remaining, Math.ceil, countdown.duration >= 3600000) : durationText(elapsed, Math.floor)}</div>
            <div className="time-actions">
              <IconButton
                label={mode === 'timer' ? 'Reset timer' : 'Reset stopwatch'}
                onClick={mode === 'timer' ? () => configure(countdown.duration / 60000) : () => setStopwatch(defaultStopwatch)}
              ><RotateCcw /></IconButton>
              <IconButton
                className="start-clock"
                label={mode === 'timer' ? running ? 'Pause timer' : 'Start timer' : stopwatch.startedAt ? 'Pause stopwatch' : 'Start stopwatch'}
                onClick={mode === 'timer' ? toggleTimer : toggleStopwatch}
              >{(mode === 'timer' ? running : stopwatch.startedAt) ? <Pause /> : <Play />}</IconButton>
            </div>
          </div>
          {mode === 'timer' ? (
            <div className="time-bottom timer-presets">
              {!fixedMode && [5, 15, 25].map(value => (
                <button key={value} type="button" className="timer-preset" aria-pressed={countdown.duration === value * 60000} onClick={() => configure(value)}>{value}m</button>
              ))}
              {finished && <span className="timer-done" role="status">Time’s up</span>}
              <Popover.Root open={durationOpen} onOpenChange={setDurationOpen}>
                <Popover.Trigger asChild><IconButton className="duration-button" label="Set timer duration"><AlarmClock /></IconButton></Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content className="duration-popover" align="end" side={fixedMode ? 'top' : 'bottom'} sideOffset={5} aria-label="Timer duration">
                    <form onSubmit={event => {
                      event.preventDefault()
                      const data = new FormData(event.currentTarget)
                      const duration = Number(data.get('hours')) * 60 + Number(data.get('minutes'))
                      if (!Number.isInteger(duration) || duration < 1 || duration > 5999) return
                      configure(duration)
                      setDurationOpen(false)
                    }}>
                      <label>Hours<input name="hours" type="number" min={0} max={99} defaultValue={Math.floor(countdown.duration / 3600000)} required /></label>
                      <label>Minutes<input name="minutes" type="number" min={0} max={59} defaultValue={Math.floor(countdown.duration / 60000) % 60} required /></label>
                      <button type="submit">Set</button>
                    </form>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>
          ) : <div className="time-bottom"><span>{stopwatch.startedAt ? 'Running' : elapsed ? 'Paused' : 'Ready'}</span></div>}
        </>
      )}
    </section>
  )
}
