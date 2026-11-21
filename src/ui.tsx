import * as Tooltip from '@radix-ui/react-tooltip'
import * as Dropdown from '@radix-ui/react-dropdown-menu'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
import { Check } from 'lucide-react'

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  selected?: boolean
}>(function IconButton({ label, selected, className, children, ...props }, ref) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          {...props}
          ref={ref}
          type="button"
          className={`icon-button ${className ?? ''}`}
          aria-label={label}
          aria-pressed={selected}
          data-selected={selected ? '' : undefined}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>{label}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
})

export function Menu({
  trigger, children, align = 'end',
}: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{trigger}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align={align} sideOffset={7} collisionPadding={8}>
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

export function MenuItem({ children, onSelect, checked, disabled }: {
  children: ReactNode; onSelect: () => void; checked?: boolean; disabled?: boolean
}) {
  return (
    <Dropdown.Item className="menu-item" onSelect={onSelect} disabled={disabled}>
      {children}
      {checked && <Check className="menu-check" />}
    </Dropdown.Item>
  )
}

export const MenuSeparator = () => <Dropdown.Separator className="menu-separator" />
