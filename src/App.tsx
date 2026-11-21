import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as Popover from '@radix-ui/react-popover'
import {
  ArrowUpRight, Check, CircleAlert, Copy, Ellipsis, Files, GripHorizontal, Minus, PanelLeft, Palette,
  Pin, PinOff, Plus, RotateCcw, Search, SlidersHorizontal, Star, StickyNote, Trash2, X, Clock3,
} from 'lucide-react'
import { colors, desktop, emptyBody, floatNote, loadNotes, noteText, onNoteChanged, saveNote } from './notes'
import type { Color, Note, NotePatch } from './notes'
import { IconButton, Menu, MenuItem, MenuSeparator } from './ui'
import { NoteEditor } from './Editor'
import { TimeTools, timeNames } from './TimeTools'
import type { TimeMode } from './TimeTools'

const desktopWindow = desktop ? getCurrentWindow() : null
const windowParams = new URLSearchParams(location.hash.slice(1))
const floatingId = windowParams.get('note')
const requestedTime = windowParams.get('time')
const source = crypto.randomUUID()

function upsert(notes: Note[], next: Note) {
  return notes.some(note => note.id === next.id)
    ? notes.map(note => note.id === next.id && (note.revision ?? 0) <= (next.revision ?? 0) ? next : note)
    : [...notes, next]
}

type PendingEdit = {
  id: string
  patch: NotePatch
  create?: Note
}

export function App() {
  if (requestedTime && Object.hasOwn(timeNames, requestedTime)) return <FloatingTime mode={requestedTime as TimeMode} />
  return <NotesApp />
}

function FloatingTime({ mode }: { mode: TimeMode }) {
  const [pinned, setPinned] = useState(true)
  const [error, setError] = useState('')
  const report = (reason: unknown) => setError(String(reason))

  async function togglePin() {
    if (desktopWindow) await desktopWindow.setAlwaysOnTop(!pinned)
    setPinned(!pinned)
  }

  function close() {
    if (desktopWindow) void desktopWindow.close().catch(report)
    else window.close()
  }

  return (
    <main className="time-window">
      <TimeTools fixedMode={mode} windowControls={
        <div className="window-controls">
          <IconButton label={pinned ? 'Always on top: On top' : 'Always on top: Unpinned'} selected={pinned} onClick={() => void togglePin().catch(report)}>
            {pinned ? <Pin /> : <PinOff />}
          </IconButton>
          <IconButton label="Minimize" onClick={() => void desktopWindow?.minimize().catch(report)} disabled={!desktop}><Minus /></IconButton>
          <IconButton label="Close" className="window-close" onClick={close}><X /></IconButton>
        </div>
      } />
      {error && <div className="error-bar" role="alert"><CircleAlert /><span>{error}</span><IconButton label="Dismiss error" onClick={() => setError('')}><X /></IconButton></div>}
    </main>
  )
}

function NotesApp() {
  const [savedNotes, setNotes] = useState<Note[]>([])
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState(() => localStorage.getItem('real-sticky-active') ?? 'field-notes')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 620)
  const [timeVisible, setTimeVisible] = useState(true)
  const [trash, setTrash] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [error, setError] = useState('')
  const queue = useRef(Promise.resolve())
  const failures = useRef<Array<() => Promise<Note>>>([])
  const searchRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | undefined
    void (async () => {
      try {
        const incoming: Note[] = []
        let initialLoad = true
        stop = await onNoteChanged(([sender, note]) => {
          if (cancelled || sender === source) return
          if (initialLoad) incoming.push(note)
          else setNotes(all => upsert(all, note))
        })
        if (cancelled) return stop()
        const all = await loadNotes()
        initialLoad = false
        if (!cancelled) setNotes(incoming.reduce(upsert, all))
      } catch (reason) {
        if (!cancelled) setError(`Could not load notes. ${String(reason)}`)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    if (desktopWindow) void desktopWindow.isAlwaysOnTop().then(setPinned).catch(() => {})
    return () => { cancelled = true; stop?.() }
  }, [])

  const notes = useMemo(() => pendingEdits.reduce((all, edit) => {
    if (edit.create) return upsert(all, edit.create)
    return all.map(note => note.id === edit.id ? { ...note, ...edit.patch } : note)
  }, savedNotes), [savedNotes, pendingEdits])

  const visible = useMemo(() => notes
    .filter(note => note.trashed === trash && (!query.trim() || `${note.title} ${noteText(note.body)}`.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt),
  [notes, query, trash])

  const active = floatingId
    ? notes.find(note => note.id === floatingId)
    : visible.find(note => note.id === activeId) ?? visible[0]

  const persist = useCallback((operation: () => Promise<Note>) => {
    queue.current = queue.current.then(async () => {
      if (failures.current.length) {
        failures.current.push(operation)
        return
      }
      try {
        await operation()
      } catch (reason) {
        failures.current.push(operation)
        setError(`Could not save your note. ${String(reason)}`)
      }
    })
  }, [])

  function retry() {
    const pending = failures.current.splice(0)
    setError('')
    pending.forEach(persist)
  }

  const editNote = useCallback((edit: PendingEdit) => {
    setPendingEdits(edits => [...edits, edit])
    persist(async () => {
      const saved = await saveNote(source, edit.id, edit.patch, edit.create)
      setNotes(all => upsert(all, saved))
      setPendingEdits(edits => edits.filter(pending => pending !== edit))
      return saved
    })
  }, [persist])

  function change(note: Note, patch: NotePatch) {
    editNote({ id: note.id, patch: { ...patch, updatedAt: Date.now() } })
  }

  function select(id: string) {
    setActiveId(id)
    localStorage.setItem('real-sticky-active', id)
    if (window.innerWidth <= 620) setSidebarOpen(false)
  }

  const create = useCallback((from?: Note) => {
    if (!loaded) return
    const note: Note = {
      id: crypto.randomUUID(), title: from ? `${from.title || 'Untitled'} copy` : '',
      body: from?.body ?? emptyBody, color: from?.color ?? 'butter',
      updatedAt: Date.now(), trashed: false, favorite: false,
    }
    setTrash(false)
    setQuery('')
    setActiveId(note.id)
    localStorage.setItem('real-sticky-active', note.id)
    if (window.innerWidth <= 620) setSidebarOpen(false)
    editNote({ id: note.id, patch: {}, create: note })
    requestAnimationFrame(() => titleRef.current?.focus())
  }, [loaded, editNote])

  function toggleSearch() {
    if (!sidebarOpen) setSidebarOpen(true)
    if (searchOpen && sidebarOpen) {
      setSearchOpen(false)
      setQuery('')
    } else {
      setSearchOpen(true)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (floatingId || (!event.ctrlKey && !event.metaKey)) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        create()
      }
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSidebarOpen(true)
        setSearchOpen(true)
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [create])

  const report = (reason: unknown) => setError(String(reason))

  async function togglePin() {
    if (desktopWindow) await desktopWindow.setAlwaysOnTop(!pinned)
    setPinned(!pinned)
  }

  async function close() {
    await queue.current
    if (failures.current.length) return
    if (desktopWindow) await desktopWindow.close()
    else if (floatingId) window.close()
  }

  useEffect(() => {
    if (!desktopWindow) return
    let disposed = false
    let stop: (() => void) | undefined
    let closing = false
    void desktopWindow.onCloseRequested(async event => {
      if (closing) return
      event.preventDefault()
      await queue.current
      if (failures.current.length) return
      closing = true
      try { await desktopWindow.destroy() } catch (reason) { closing = false; setError(String(reason)) }
    }).then(unlisten => {
      if (disposed) unlisten()
      else stop = unlisten
    }).catch(() => {})
    return () => { disposed = true; stop?.() }
  }, [])

  async function copy(note: Note) {
    await navigator.clipboard.writeText([note.title, noteText(note.body)].filter(Boolean).join('\n\n'))
  }

  const pinLabel = `Always on top: ${pinned ? 'On top' : 'Unpinned'}`
  const windowActions = (
    <>
      <IconButton label="Minimize" onClick={() => void desktopWindow?.minimize().catch(report)} disabled={!desktop}><Minus /></IconButton>
      <IconButton label="Close" className="window-close" onClick={() => void close().catch(report)} disabled={!desktop && !floatingId}><X /></IconButton>
    </>
  )

  const floatingControls = (
    <div className="sticky-controls">
      {active && (
        <IconButton label={toolsOpen ? 'Hide note tools' : 'Show note tools'} aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)}>
          <SlidersHorizontal />
        </IconButton>
      )}
      <IconButton label={pinLabel} selected={pinned} onClick={() => void togglePin().catch(report)}>
        {pinned ? <Pin /> : <PinOff />}
      </IconButton>
      {windowActions}
    </div>
  )

  return (
    <div className={`app ${floatingId ? 'floating' : ''}`}>
      {!floatingId && <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <div className="brand-mark" data-tauri-drag-region><StickyNote aria-hidden="true" /></div>
          <span data-tauri-drag-region>Real Sticky</span>
        </div>
        <div className="titlebar-space" data-tauri-drag-region />
        <div className="window-controls">
          <button type="button" className="pin-toggle" aria-label={pinLabel} aria-pressed={pinned} onClick={() => void togglePin().catch(report)}>
            {pinned ? <Pin /> : <PinOff />}
            <span>{pinned ? 'On top' : 'Unpinned'}</span>
          </button>
          <span className="window-divider" />
          {windowActions}
        </div>
      </header>}

      <div className={`workspace ${sidebarOpen ? '' : 'rail-closed'}`}>
        {!floatingId && (
          <aside className="sidebar" aria-label="Notes library">
            <div className="sidebar-head">
              <div><h1>{trash ? 'Trash' : 'Notes'}</h1><span className="note-count">{visible.length}</span></div>
              <div className="sidebar-actions">
                <IconButton label="Search notes" selected={searchOpen} onClick={toggleSearch}><Search /></IconButton>
                <IconButton label="New note" className="add-button" onClick={() => create()} disabled={!loaded}><Plus /></IconButton>
              </div>
            </div>
            {searchOpen && (
              <div className="search-row">
                <Search />
                <input ref={searchRef} aria-label="Search notes" placeholder="Find a note…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') toggleSearch() }} />
                <IconButton label="Close search" onClick={toggleSearch}><X /></IconButton>
              </div>
            )}
            <div className="note-list" aria-label={trash ? 'Trashed notes' : 'Saved notes'}>
              {visible.map(note => (
                <button
                  key={note.id} type="button" className="note-row"
                  data-active={active?.id === note.id ? '' : undefined}
                  aria-current={active?.id === note.id ? 'true' : undefined}
                  onClick={() => select(note.id)}
                >
                  <span className="note-marker" style={{ background: colors[note.color].swatch }} />
                  <span className="note-row-copy"><strong>{note.title || 'Untitled'}</strong><small>{noteText(note.body).trim().replace(/\s+/g, ' ') || 'Empty note'}</small></span>
                  {note.favorite && <Star className="row-star" />}
                </button>
              ))}
              {loaded && visible.length === 0 && <div className="no-list">{query ? 'No matches' : trash ? 'Trash is empty' : 'No notes yet'}</div>}
            </div>
            <div className="sidebar-bottom">
              <div hidden={!timeVisible}><TimeTools onError={report} /></div>
              <div className="utility-bar">
                <IconButton label={trash ? 'Back to notes' : 'Open trash'} selected={trash} onClick={() => { setTrash(!trash); setQuery('') }}>{trash ? <Files /> : <Trash2 />}</IconButton>
                <IconButton label={timeVisible ? 'Hide time tools' : 'Show time tools'} selected={timeVisible} onClick={() => setTimeVisible(!timeVisible)}><Clock3 /></IconButton>
                <IconButton label="Hide notes sidebar" onClick={() => setSidebarOpen(false)}><PanelLeft /></IconButton>
              </div>
            </div>
          </aside>
        )}

        <main className="desk" aria-label="Note workspace">
          {floatingId && <h1 className="sr-only">Floating note</h1>}
          {!floatingId && <div className="desk-top">
            <div className="desk-label">
              {!sidebarOpen && <IconButton label="Show notes sidebar" onClick={() => setSidebarOpen(true)}><PanelLeft /></IconButton>}
              <StickyNote /> <span>{trash ? 'Trashed note' : 'Sticky note'}</span>
            </div>
            {active && !active.trashed && (
              <button type="button" className="float-action" onClick={() => {
                void queue.current.then(() => floatNote(active.id)).catch(report)
              }}><ArrowUpRight /> <span>Float note</span></button>
            )}
          </div>}

          {active ? (
            <article className="paper" data-tone={colors[active.color].tone} style={{ '--paper': colors[active.color].paper } as CSSProperties}>
              <div className="paper-head" data-tauri-drag-region={floatingId ? '' : undefined}>
                <input
                  key={active.id}
                  ref={titleRef}
                  className="note-title"
                  aria-label="Note title"
                  placeholder="Untitled"
                  value={active.title}
                  readOnly={active.trashed}
                  onChange={event => change(active, { title: event.target.value })}
                />
                {floatingId && (
                  <>
                    <div className="note-grip" data-tauri-drag-region aria-hidden="true" title="Drag note"><GripHorizontal /></div>
                    {floatingControls}
                  </>
                )}
                <div className="paper-actions" hidden={!!floatingId && !toolsOpen}>
                  {active.trashed ? (
                    <IconButton label="Restore note" onClick={() => { change(active, { trashed: false }); setTrash(false); select(active.id) }}><RotateCcw /></IconButton>
                  ) : (
                    <>
                      <IconButton label={active.favorite ? 'Unstar note' : 'Star note'} selected={active.favorite} className="favorite" onClick={() => change(active, { favorite: !active.favorite })}><Star /></IconButton>
                      <Popover.Root>
                        <Popover.Trigger asChild><IconButton label="Note color"><Palette /></IconButton></Popover.Trigger>
                        <Popover.Portal>
                          <Popover.Content className="palette-popover" align="end" sideOffset={7} collisionPadding={8} aria-label="Note colors">
                            {Object.entries(colors).map(([key, value]) => (
                              <Popover.Close asChild key={key}>
                                <button type="button" className="swatch" data-tone={value.tone} title={value.name} aria-label={value.name} aria-pressed={active.color === key} style={{ background: value.swatch }} onClick={() => change(active, { color: key as Color })}>
                                  {active.color === key && <Check />}
                                </button>
                              </Popover.Close>
                            ))}
                          </Popover.Content>
                        </Popover.Portal>
                      </Popover.Root>
                      <Menu trigger={<IconButton label="Note options"><Ellipsis /></IconButton>}>
                        <MenuItem onSelect={() => void copy(active).catch(report)}><Copy /> Copy text</MenuItem>
                        {!floatingId && <MenuItem onSelect={() => create(active)}><Files /> Duplicate</MenuItem>}
                        <MenuSeparator />
                        <MenuItem onSelect={() => change(active, { trashed: true })}><Trash2 /> Move to trash</MenuItem>
                      </Menu>
                    </>
                  )}
                </div>
              </div>
              {active.trashed ? (
                <div className="trashed-body">{noteText(active.body) || 'Empty note'}</div>
              ) : <NoteEditor key={active.id} body={active.body} onChange={body => change(active, { body })} showTools={!floatingId || toolsOpen} />}
            </article>
          ) : (
            <>
              {floatingId && <div className="floating-empty-bar" data-tauri-drag-region>{floatingControls}</div>}
              <div className="blank-paper">
                <StickyNote />
                <span>{!loaded ? 'Opening notes…' : query ? 'No notes match your search' : trash ? 'Trash is empty' : floatingId ? 'Note unavailable' : 'Your notes start here'}</span>
                {loaded && !trash && !query && !floatingId && !error && <button type="button" onClick={() => create()}><Plus /> New note</button>}
              </div>
            </>
          )}
        </main>
      </div>
      {error && <div className="error-bar" role="alert"><CircleAlert /><span>{error}</span>{failures.current.length > 0 ? <button onClick={retry}>Retry</button> : <IconButton label="Dismiss error" onClick={() => setError('')}><X /></IconButton>}</div>}
    </div>
  )
}
