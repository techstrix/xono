import { useState, type ReactNode } from 'react'

export function Field({
  label,
  hint,
  children,
  wide
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  wide?: boolean
}): React.JSX.Element {
  return (
    <label className={`field ${wide ? 'field--wide' : ''}`}>
      <span className="field__label">{label}</span>
      <span className="field__control">{children}</span>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`toggle ${checked ? 'toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__knob" />
    </button>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  secret,
  disabled,
  spellCheck = false
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'number'
  secret?: boolean
  disabled?: boolean
  spellCheck?: boolean
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const isPassword = secret || type === 'password'
  return (
    <span className="input-wrap">
      <input
        type={isPassword && !revealed ? 'password' : type === 'password' ? 'password' : type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={spellCheck}
        onChange={(e) => onChange(e.target.value)}
      />
      {secret ? (
        <button
          type="button"
          className="input-wrap__btn"
          onClick={() => setRevealed(!revealed)}
          aria-label={revealed ? 'Hide' : 'Show'}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      ) : null}
    </span>
  )
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Section({
  title,
  headerExtra,
  children
}: {
  title: string
  headerExtra?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="section">
      <div className="section__head">
        <h3 className="section__title">{title}</h3>
        {headerExtra}
      </div>
      <div className="section__body">{children}</div>
    </section>
  )
}

export function Badge({
  tone,
  children
}: {
  tone: 'ok' | 'warn' | 'error' | 'muted'
  children: ReactNode
}): React.JSX.Element {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function Button({
  children,
  onClick,
  variant,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button type="button" className={`btn btn--${variant ?? 'ghost'}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`
  return `${bytes} B`
}