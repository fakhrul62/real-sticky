import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { JSONContent } from '@tiptap/react'

type NoteColor = { name: string; paper: string; swatch: string; tone?: 'dark' }

const palette = {
  butter: { name: 'Butter', paper: '#fbefa5', swatch: '#f2db79' },
  sage: { name: 'Sage', paper: '#dce8bd', swatch: '#c1d29a' },
  blush: { name: 'Blush', paper: '#f3d3cf', swatch: '#e9b4ae' },
  sky: { name: 'Sky', paper: '#d4e4f2', swatch: '#aecae3' },
  lilac: { name: 'Lilac', paper: '#e7daf3', swatch: '#d3bce6' },
  oat: { name: 'Oat', paper: '#eee4d2', swatch: '#dbcbad' },
  chalk: { name: 'Chalk', paper: '#fffefa', swatch: '#f7f6ef' },
  pearl: { name: 'Pearl', paper: '#eff0ee', swatch: '#e7e9e5' },
  linen: { name: 'Linen', paper: '#f4f0e8', swatch: '#e9e2d5' },
  mist: { name: 'Mist', paper: '#e0e6e6', swatch: '#cbd5d6' },
  clay: { name: 'Clay', paper: '#e8dcd7', swatch: '#d8c5bf' },
  lichen: { name: 'Lichen', paper: '#dde3d8', swatch: '#c6d1c3' },
  graphite: { name: 'Graphite', paper: '#454747', swatch: '#575a5a', tone: 'dark' },
  charcoal: { name: 'Charcoal', paper: '#30312e', swatch: '#444541', tone: 'dark' },
  ink: { name: 'Ink', paper: '#242622', swatch: '#30332d', tone: 'dark' },
  slate: { name: 'Slate', paper: '#34404d', swatch: '#49586a', tone: 'dark' },
  moss: { name: 'Moss', paper: '#343e35', swatch: '#475749', tone: 'dark' },
  plum: { name: 'Plum', paper: '#453a45', swatch: '#594b59', tone: 'dark' },
} as const satisfies Record<string, NoteColor>

export type Color = keyof typeof palette
export const colors: Record<Color, NoteColor> = palette

export type Note = {
  id: string
  title: string
  body: JSONContent
  color: Color
  updatedAt: number
  revision?: number
  favorite: boolean
  trashed: boolean
}

export type NotePatch = Partial<Omit<Note, 'id' | 'revision'>>
export const emptyBody: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const task = (text: string, checked = false): JSONContent => ({
  type: 'taskItem', attrs: { checked }, content: [paragraph(text)],
})

const seededAt = Date.now()
const seed: Note[] = [
  {
    id: 'field-notes', title: 'Today’s focus', color: 'butter', favorite: true, trashed: false, updatedAt: seededAt,
    body: {
      type: 'doc',
      content: [
        paragraph('A few things to get out of my head and onto paper.'),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Make time for' }] },
        {
          type: 'taskList',
          content: [
            task('Clear the desk', true),
            task('Pick one thing to finish'),
            task('Take a proper break'),
          ],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Keep in mind' }] },
        paragraph('Start small. Leave room for the unexpected.'),
      ],
    },
  },
  {
    id: 'idea-parking', title: 'Idea parking lot', color: 'sage', favorite: false, trashed: false, updatedAt: seededAt - 2000,
    body: { type: 'doc', content: [paragraph('For the ideas that can wait a little.')] },
  },
  {
    id: 'weekend', title: 'Weekend list', color: 'blush', favorite: false, trashed: false, updatedAt: seededAt - 4000,
    body: { type: 'doc', content: [{ type: 'taskList', content: [task('Pick up coffee'), task('Go for a walk')] }] },
  },
]

export function noteText(node: JSONContent): string {
  if (node.text) return node.text
  const contents = node.content?.map(noteText) ?? []
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'tableRow') return contents.join('\t')
  if (node.type === 'taskItem') return `${node.attrs?.checked ? '[x]' : '[ ]'} ${contents.join('\n')}`
  if (node.type === 'listItem') return `• ${contents.join('\n')}`
  return contents.join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n')
}

export const desktop = isTauri()
const storageKey = 'real-sticky-notes-v1'
type Change = [source: string, note: Note]
const channel = desktop ? null : new BroadcastChannel('real-sticky-notes')

function browserNotes(): Note[] {
  const saved = localStorage.getItem(storageKey)
  if (saved) return JSON.parse(saved)
  localStorage.setItem(storageKey, JSON.stringify(seed))
  return seed
}

export async function loadNotes() {
  return desktop ? invoke<Note[]>('load_notes', { seed }) : browserNotes()
}

export async function saveNote(source: string, id: string, patch: NotePatch, create?: Note) {
  if (desktop) return invoke<Note>('write_note', { source, id, patch, create: create ?? null })
  const notes = browserNotes()
  const original = create ?? notes.find(note => note.id === id)
  if (!original) throw new Error('Note no longer exists')
  const updated = { ...original, ...patch, revision: (original.revision ?? 0) + 1 }
  localStorage.setItem(storageKey, JSON.stringify([...notes.filter(note => note.id !== id), updated]))
  channel?.postMessage([source, updated] satisfies Change)
  return updated
}

export async function onNoteChanged(callback: (change: Change) => void) {
  if (desktop) return listen<Change>('note-changed', event => callback(event.payload))
  const handler = (event: MessageEvent<Change>) => callback(event.data)
  channel?.addEventListener('message', handler)
  return () => channel?.removeEventListener('message', handler)
}

export async function floatNote(id: string) {
  if (desktop) await invoke('float_note', { id })
  else window.open(`#note=${id}`, `note-${id}`, 'width=330,height=360,popup')
}
