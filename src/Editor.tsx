import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { ChainedCommands, JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Placeholder from '@tiptap/extension-placeholder'
import {
  Bold, CheckSquare, Code2, Heading2, Italic, List, ListOrdered, Quote, Redo2,
  Strikethrough, Table2, Underline, Undo2, Type, Ellipsis,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { IconButton, Menu, MenuItem, MenuSeparator } from './ui'

const extensions = [
  StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true, HTMLAttributes: { "data-type": "taskItem" } }),
  TableKit,
  Placeholder.configure({ placeholder: 'Start writing…' }),
]

type Format = [label: string, icon: LucideIcon, key: string, action: (chain: ChainedCommands) => ChainedCommands]
const formats: Format[] = [
  ['Bold', Bold, 'bold', chain => chain.toggleBold()],
  ['Italic', Italic, 'italic', chain => chain.toggleItalic()],
  ['Underline', Underline, 'underline', chain => chain.toggleUnderline()],
  ['Strikethrough', Strikethrough, 'strike', chain => chain.toggleStrike()],
  ['Bulleted list', List, 'bulletList', chain => chain.toggleBulletList()],
  ['Numbered list', ListOrdered, 'orderedList', chain => chain.toggleOrderedList()],
  ['Checklist', CheckSquare, 'taskList', chain => chain.toggleTaskList()],
]

export function NoteEditor({ body, onChange, showTools }: {
  body: JSONContent
  onChange: (body: JSONContent) => void
  showTools: boolean
}) {
  const editor = useEditor({
    extensions,
    content: body,
    shouldRerenderOnTransaction: true,
    editorProps: { attributes: { 'aria-label': 'Note body', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' } },
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  })

  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(body)) {
      const { from, to } = editor.state.selection
      editor.commands.setContent(body, { emitUpdate: false })
      const end = editor.state.doc.content.size
      editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) })
    }
  }, [editor, body])

  if (!editor) return null

  const run = (action: (chain: ChainedCommands) => ChainedCommands) => action(editor.chain().focus()).run()
  const inTable = editor.isActive('table')

  return (
    <>
      <div className="format-bar" role="group" aria-label="Note formatting" hidden={!showTools}>
        <Menu align="start" trigger={<IconButton label="Text style"><Type /></IconButton>}>
          <MenuItem checked={editor.isActive('paragraph')} onSelect={() => run(chain => chain.setParagraph())}><Type /> Paragraph</MenuItem>
          <MenuItem checked={editor.isActive('heading', { level: 2 })} onSelect={() => run(chain => chain.toggleHeading({ level: 2 }))}><Heading2 /> Heading</MenuItem>
          <MenuItem checked={editor.isActive('blockquote')} onSelect={() => run(chain => chain.toggleBlockquote())}><Quote /> Quote</MenuItem>
          <MenuItem checked={editor.isActive('codeBlock')} onSelect={() => run(chain => chain.toggleCodeBlock())}><Code2 /> Code block</MenuItem>
        </Menu>
        <span className="format-divider" />
        {formats.map(([label, Icon, key, action]) => (
          <IconButton
            key={key}
            label={label}
            selected={editor.isActive(key)}
            className={key === 'strike' ? 'wide-format' : ''}
            onMouseDown={event => event.preventDefault()}
            onClick={() => run(action)}
          ><Icon /></IconButton>
        ))}
        <span className="format-divider" />
        <Menu align="start" trigger={<IconButton label="Table options" selected={inTable}><Table2 /></IconButton>}>
          <MenuItem onSelect={() => run(chain => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}>
            <Table2 /> Insert table
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!inTable} onSelect={() => run(chain => chain.addRowAfter())}>Add row below</MenuItem>
          <MenuItem disabled={!inTable} onSelect={() => run(chain => chain.addColumnAfter())}>Add column after</MenuItem>
          <MenuItem disabled={!inTable} onSelect={() => run(chain => chain.deleteRow())}>Delete row</MenuItem>
          <MenuItem disabled={!inTable} onSelect={() => run(chain => chain.deleteColumn())}>Delete column</MenuItem>
          <MenuItem disabled={!inTable} onSelect={() => run(chain => chain.deleteTable())}>Delete table</MenuItem>
        </Menu>
        <div className="format-history">
          <IconButton label="Undo" disabled={!editor.can().undo()} onMouseDown={event => event.preventDefault()} onClick={() => run(chain => chain.undo())}><Undo2 /></IconButton>
          <IconButton label="Redo" disabled={!editor.can().redo()} onMouseDown={event => event.preventDefault()} onClick={() => run(chain => chain.redo())}><Redo2 /></IconButton>
        </div>
        <div className="compact-format">
          <Menu trigger={<IconButton label="More formatting"><Ellipsis /></IconButton>}>
            <MenuItem checked={editor.isActive('strike')} onSelect={() => run(chain => chain.toggleStrike())}><Strikethrough /> Strikethrough</MenuItem>
            <MenuItem disabled={!editor.can().undo()} onSelect={() => run(chain => chain.undo())}><Undo2 /> Undo</MenuItem>
            <MenuItem disabled={!editor.can().redo()} onSelect={() => run(chain => chain.redo())}><Redo2 /> Redo</MenuItem>
          </Menu>
        </div>
      </div>
      <EditorContent className="note-content" editor={editor} />
    </>
  )
}
