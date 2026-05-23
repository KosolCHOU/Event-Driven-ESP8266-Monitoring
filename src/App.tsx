import {
  useState, useMemo, useEffect, useRef, useCallback,
} from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceArea,
} from 'recharts'
import {
  SlidersHorizontal, Activity, BatteryCharging,
  CheckCircle, TrendingDown, Droplets, Thermometer,
  Wifi, Zap, Play, Pause, RotateCcw,
} from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────

type Scenario      = 'stable' | 'drying' | 'irrigation'
type PlaybackSpeed = 1 | 5 | 10

interface Pt {
  cycle:    number
  time:     number
  moisture: number
  isTx:     boolean
}

// ─── Deterministic PRNG (LCG) ──────────────────────────────────────────────

function makePrng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// ─── Dataset Generation ────────────────────────────────────────────────────

function genStableSoil(): Pt[] {
  const rng = makePrng(0xabcd1234)
  return Array.from({ length: 600 }, (_, i) => ({
    cycle: i, time: +(i / 20).toFixed(3),
    moisture: 38 + rng() * 4, isTx: false,
  }))
}

function genGradualDrying(): Pt[] {
  const rng = makePrng(0xdeadbeef)
  return Array.from({ length: 600 }, (_, i) => ({
    cycle: i, time: +(i / 20).toFixed(3),
    moisture: 42 - (12 * i) / 599 + (rng() - 0.5) * 0.3, isTx: false,
  }))
}

function genIrrigationEvent(): Pt[] {
  const rng = makePrng(0xcafe8765)
  return Array.from({ length: 600 }, (_, i) => {
    let moisture: number
    if      (i < 250) moisture = 37 + (rng() - 0.5) * 0.5
    else if (i < 400) moisture = 45 + (rng() - 0.5) * 0.5
    else              moisture = 40 + (rng() - 0.5) * 0.5
    return { cycle: i, time: +(i / 20).toFixed(3), moisture, isTx: false }
  })
}

// ─── Custom Recharts Dot ───────────────────────────────────────────────────

function TxDot(props: { cx?: number; cy?: number; payload?: Pt; [k: string]: unknown }) {
  const { cx = 0, cy = 0, payload } = props
  if (!payload?.isTx) return <circle r={0} cx={cx} cy={cy} />
  const s = 8
  return (
    <polygon
      points={`${cx},${cy - s} ${cx - s * 0.85},${cy + s * 0.55} ${cx + s * 0.85},${cy + s * 0.55}`}
      fill="#8b5cf6"
    />
  )
}

// ─── Flat Ambient Sparkline ────────────────────────────────────────────────

function FlatSparkline({ seed, compact = false }: { seed: number; compact?: boolean }) {
  const rng = makePrng(seed)
  const pts = Array.from({ length: 30 }, (_, i) =>
    `${(i / 29) * 200},${20 + (rng() - 0.5) * 6}`
  ).join(' ')
  return (
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" className={compact ? 'w-12 h-6' : 'w-full h-10 mt-1'}>
      <polyline points={pts} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Scenario Button (desktop sidebar) ────────────────────────────────────

function ScenBtn({ active, label, icon, onClick }: {
  active: boolean; label: string; icon: React.ReactNode; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all ${
        active
          ? 'border-emerald-500 bg-emerald-50/60 shadow-[0_0_0_1px_#10b981]'
          : 'border-slate-200 bg-slate-50 hover:border-emerald-400'
      }`}
    >
      <span className={`text-sm font-semibold ${active ? 'text-slate-700' : 'text-slate-500'}`}>{label}</span>
      <span className={active ? 'text-emerald-500' : 'text-slate-400'}>{icon}</span>
    </button>
  )
}

// ─── Custom Tooltip ────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean; payload?: { value: number; payload: Pt }[]; label?: number
}) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-md text-xs">
      <p className="text-slate-400 mb-0.5">t = {label}m</p>
      <p className="text-emerald-600 font-semibold">{p.value.toFixed(2)} % VWC</p>
      {p.payload?.isTx && <p className="text-purple-500 font-medium mt-0.5">▲ Transmission event</p>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  App
// ═══════════════════════════════════════════════════════════════════════════

const TICK_MS = 50

const SCENARIOS: { key: Scenario; label: string; shortLabel: string; icon: React.ReactNode }[] = [
  { key: 'stable',     label: 'Stable Soil',      shortLabel: 'Stable',   icon: <CheckCircle  size={14} /> },
  { key: 'drying',     label: 'Gradual Drying',   shortLabel: 'Drying',   icon: <TrendingDown size={14} /> },
  { key: 'irrigation', label: 'Irrigation Event', shortLabel: 'Irrigate', icon: <Droplets     size={14} /> },
]

// ─── Noise toggle (reused in both layouts) ─────────────────────────────────

function NoiseToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="relative flex-shrink-0">
      <input type="checkbox" className="sr-only peer" checked={checked} onChange={e => onChange(e.target.checked)} />
      <div className="w-9 h-5 bg-slate-200 rounded-full peer peer-checked:bg-emerald-500
        after:content-[''] after:absolute after:top-[2px] after:left-[2px]
        after:bg-white after:rounded-full after:h-4 after:w-4
        after:transition-all peer-checked:after:translate-x-4" />
    </div>
  )
}

export default function App() {
  // ── UI State ──────────────────────────────────────────────────────────
  const [scenario,      setScenario]      = useState<Scenario>('stable')
  const [delta,         setDelta]         = useState(4.0)
  const [noiseOn,       setNoiseOn]       = useState(true)
  const [isPlaying,     setIsPlaying]     = useState(false)
  const [currentIndex,  setCurrentIndex]  = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1)

  // ── Stream State ───────────────────────────────────────────────────────
  const [visibleData,               setVisibleData]               = useState<Pt[]>([])
  const [lastTransmittedValueState, setLastTransmittedValueState] = useState(0)
  const [sodCount,                  setSodCount]                  = useState(0)
  const [txFlashKey,   setTxFlashKey]   = useState(0)
  const [liveTemp,     setLiveTemp]     = useState(30.8)
  const [liveHumidity, setLiveHumidity] = useState(48)

  // ── Refs ───────────────────────────────────────────────────────────────
  const intervalRef      = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentIndexRef  = useRef(0)
  const lastTransmittedValueStateRef         = useRef(0)
  const sodCountRef      = useRef(0)
  const deltaRef         = useRef(delta)
  const playbackSpeedRef = useRef<number>(1)
  const isPlayingRef     = useRef(false)
  const noiseOnRef       = useRef(noiseOn)
  const activeDataRef    = useRef<Pt[]>([])
  const autoRestartRef   = useRef(false)

  // ── Raw datasets ───────────────────────────────────────────────────────
  const rawData = useMemo(() => ({
    stable:     genStableSoil(),
    drying:     genGradualDrying(),
    irrigation: genIrrigationEvent(),
  }), [])

  useEffect(() => { deltaRef.current        = delta         }, [delta])
  useEffect(() => { playbackSpeedRef.current = playbackSpeed }, [playbackSpeed])
  useEffect(() => { noiseOnRef.current      = noiseOn       }, [noiseOn])

  // ── Interval helpers ───────────────────────────────────────────────────

  const stopInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const startInterval = useCallback(() => {
    stopInterval()
    intervalRef.current = setInterval(() => {
      if (currentIndexRef.current >= activeDataRef.current.length) {
        stopInterval(); setIsPlaying(false); isPlayingRef.current = false; return
      }

      const newPts: Pt[] = []
      let txOccurred = false

      for (
        let i = 0;
        i < playbackSpeedRef.current && currentIndexRef.current < activeDataRef.current.length;
        i++
      ) {
        const idx           = currentIndexRef.current
        const cleanMoisture = activeDataRef.current[idx].moisture  // baseline: no noise
        const pt: Pt        = { ...activeDataRef.current[idx], isTx: false }

        // SoD evaluation on clean baseline — noise must not influence transmission decisions
        if (idx === 0) {
          pt.isTx = true; lastTransmittedValueStateRef.current = cleanMoisture; sodCountRef.current = 1; txOccurred = true
          setLastTransmittedValueState(cleanMoisture)
        } else if (Math.abs(cleanMoisture - lastTransmittedValueStateRef.current) >= deltaRef.current) {
          pt.isTx = true; lastTransmittedValueStateRef.current = cleanMoisture; sodCountRef.current++; txOccurred = true
          setLastTransmittedValueState(cleanMoisture)
        }

        // Apply ±1.2% jitter purely for visual display; SoD logic is already decided above
        if (noiseOnRef.current) {
          pt.moisture = Math.min(46, Math.max(30, cleanMoisture + (Math.random() * 2.4 - 1.2)))
        }

        newPts.push(pt)
        currentIndexRef.current++
      }

      setVisibleData(prev => [...prev, ...newPts])
      setCurrentIndex(currentIndexRef.current)
      setSodCount(sodCountRef.current)
      if (txOccurred) setTxFlashKey(k => k + 1)
      setLiveTemp(Math.min(31.1, Math.max(30.5, 30.8 + (Math.random() * 0.4 - 0.2))))
      setLiveHumidity(Math.min(50, Math.max(46, 48 + Math.floor(Math.random() * 3 - 1))))
    }, TICK_MS)
  }, [stopInterval])

  // ── Scenario change ────────────────────────────────────────────────────
  useEffect(() => {
    const shouldRestart = autoRestartRef.current
    autoRestartRef.current = false

    stopInterval()
    currentIndexRef.current = 0; lastTransmittedValueStateRef.current = 0; sodCountRef.current = 0
    setVisibleData([]); setCurrentIndex(0); setLastTransmittedValueState(0); setSodCount(0)
    setIsPlaying(false); isPlayingRef.current = false
    activeDataRef.current = rawData[scenario].map(p => ({ ...p }))

    if (shouldRestart) {
      const t = setTimeout(() => {
        setIsPlaying(true); isPlayingRef.current = true; startInterval()
      }, 60)
      return () => clearTimeout(t)
    }
  }, [scenario, rawData, stopInterval, startInterval])

  useEffect(() => () => stopInterval(), [stopInterval])

  // ── Playback handlers ──────────────────────────────────────────────────

  const handleScenarioChange = (s: Scenario) => {
    if (isPlayingRef.current) autoRestartRef.current = true
    setScenario(s)
  }

  const handlePlay = () => {
    if (currentIndexRef.current >= activeDataRef.current.length) {
      currentIndexRef.current = 0; lastTransmittedValueStateRef.current = 0; sodCountRef.current = 0
      setVisibleData([]); setCurrentIndex(0); setLastTransmittedValueState(0); setSodCount(0)
    }
    setIsPlaying(true); isPlayingRef.current = true; startInterval()
  }

  const handlePause = () => { stopInterval(); setIsPlaying(false); isPlayingRef.current = false }

  const handleReset = () => {
    stopInterval()
    currentIndexRef.current = 0; lastTransmittedValueStateRef.current = 0; sodCountRef.current = 0
    setVisibleData([]); setCurrentIndex(0); setLastTransmittedValueState(0); setSodCount(0)
    setIsPlaying(false); isPlayingRef.current = false
    setLiveTemp(30.8); setLiveHumidity(48)
    activeDataRef.current = rawData[scenario].map(p => ({ ...p }))
  }

  const handleIrrigation = () => {
    const start = currentIndexRef.current
    const end   = Math.min(start + 10, activeDataRef.current.length)
    for (let i = start; i < end; i++) {
      activeDataRef.current[i] = {
        ...activeDataRef.current[i],
        moisture: Math.min(48, activeDataRef.current[i].moisture + 8),
      }
    }
    if (!isPlayingRef.current) {
      setIsPlaying(true); isPlayingRef.current = true; startInterval()
    }
  }

  // ── Derived metrics ────────────────────────────────────────────────────
  const totalStreamed     = visibleData.length
  const progressPct      = Math.min(100, Math.floor((totalStreamed / 600) * 1000) / 10)
  const reductionRatio   = sodCount > 0
    ? ((1 - sodCount / 600) * 100).toFixed(1)
    : totalStreamed > 0 ? '100.0' : '—'
  const continuousEnergy = (totalStreamed * 0.68).toFixed(2)
  const deltaEnergy      = (sodCount * 0.68).toFixed(2)
  const sodBarPct        = Math.max(0.5, (sodCount / 600) * 100)
  const showBand         = totalStreamed > 0 && lastTransmittedValueState > 0
  const bandY1           = Math.max(30, lastTransmittedValueState - delta)
  const bandY2           = Math.min(46, lastTransmittedValueState + delta)
  const isPaused         = !isPlaying && currentIndex > 0

  // ── Recharts inner JSX (same for both layouts) ─────────────────────────
  const lineChartInner = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
      <XAxis
        dataKey="time" type="number" domain={[0, 30]}
        ticks={[0, 5, 10, 15, 20, 25, 30]} tickFormatter={v => `${v}m`}
        tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false}
      />
      <YAxis
        domain={[30, 46]} allowDataOverflow={true}
        ticks={[30, 34, 38, 42, 46]} tickFormatter={v => `${v}%`}
        tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={38}
      />
      <Tooltip content={<ChartTooltip />} />
      {showBand && (
        <ReferenceArea
          y1={bandY1} y2={bandY2} fill="#94a3b8" fillOpacity={0.13}
          stroke="#94a3b8" strokeOpacity={0.3} strokeWidth={0.75}
          strokeDasharray="4 3" ifOverflow="hidden"
        />
      )}
      <Line
        type="monotone" dataKey="moisture" stroke="#10b981" strokeWidth={2.5}
        dot={<TxDot />} activeDot={{ r: 4, fill: '#10b981', strokeWidth: 0 }}
        isAnimationActive={false}
      />
    </>
  )

  // ── Playback controls (shared) ─────────────────────────────────────────
  const playbackControls = (
    <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap">
      <button
        onClick={isPlaying ? handlePause : handlePlay}
        className={`flex items-center gap-1 lg:gap-1.5 px-2.5 lg:px-3 py-1.5 rounded-lg text-xs font-semibold
          transition-all active:scale-95 ${
          isPlaying
            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
            : 'bg-emerald-500 text-white hover:bg-emerald-600'
        }`}
      >
        {isPlaying ? <><Pause size={11} /> Pause</> : <><Play size={11} /> {isPaused ? 'Resume' : 'Play'}</>}
      </button>
      <button
        onClick={handleReset}
        className="flex items-center gap-1 lg:gap-1.5 px-2.5 lg:px-3 py-1.5 rounded-lg text-xs font-semibold
          bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all active:scale-95"
      >
        <RotateCcw size={11} /> Reset
      </button>
      <div className="w-px h-4 bg-slate-200" />
      <div className="flex rounded-md overflow-hidden border border-slate-200">
        {([1, 5, 10] as PlaybackSpeed[]).map((s, i) => (
          <button
            key={s} onClick={() => setPlaybackSpeed(s)}
            className={`px-2 lg:px-2.5 py-1.5 text-xs font-mono font-bold transition-all
              ${i > 0 ? 'border-l border-slate-200' : ''}
              ${playbackSpeed === s ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="flex-1 flex items-center gap-1.5 lg:gap-2">
        <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-400 rounded-full transition-all duration-75" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="text-[10px] font-mono text-slate-400 w-6 lg:w-7 text-right tabular-nums">
          {Math.round(progressPct)}%
        </span>
      </div>
    </div>
  )

  // ── Desktop scorecard cards ────────────────────────────────────────────
  const desktopScorecard = (
    <>
      <div className="bg-emerald-500 text-white rounded-xl p-6 shadow-sm relative overflow-hidden">
        <div className="absolute inset-0 opacity-10 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
        <p className="text-[10px] font-semibold mb-2 relative z-10 opacity-90 uppercase tracking-wider">Packet Reduction Ratio</p>
        <div className="text-[3.2rem] font-bold relative z-10 flex items-baseline leading-none gap-0.5 tabular-nums">
          {reductionRatio}
          {reductionRatio !== '—' && <span className="text-2xl font-normal">%</span>}
        </div>
        <p className="text-xs mt-2.5 relative z-10 opacity-80">Less data transmitted vs. continuous polling.</p>
      </div>

      <div className="bg-white rounded-xl p-5 shadow-sm">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-4">Network Load Comparison</p>
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex justify-between items-center text-sm mb-1.5">
              <span className="text-slate-600">Continuous Polling</span>
              <span key={`cp-${totalStreamed}`} className="font-mono text-slate-400 text-xs ref-flash tabular-nums">
                {totalStreamed} pkts
              </span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-1.5">
              <div className="bg-slate-300 h-1.5 rounded-full w-full" />
            </div>
          </div>
          <div>
            <div className="flex justify-between items-center text-sm mb-1.5">
              <span className="text-slate-700 font-semibold">Send-on-Delta</span>
              <span key={`sod-${txFlashKey}`} className="font-mono text-xs font-bold text-emerald-500 sod-flash tabular-nums">
                {sodCount} pkt{sodCount !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-1.5">
              <div className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300 ease-out" style={{ width: `${sodBarPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div key={`energy-${txFlashKey}`} className="bg-white rounded-xl p-5 shadow-sm tx-pop" style={{ transformOrigin: 'center' }}>
        <div className="flex justify-between items-center mb-4">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Estimated Wi-Fi Energy</p>
          <Zap size={13} className="text-slate-400" />
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
            <Wifi size={17} className="text-slate-400" />
          </div>
          <div>
            <p className="text-[11px] text-slate-400 font-medium">Standard Usage</p>
            <p key={`su-${totalStreamed}`} className="text-[15px] text-slate-700 ref-flash tabular-nums">{continuousEnergy} J</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <Zap size={17} className="text-emerald-500" />
          </div>
          <div>
            <p className="text-[11px] text-emerald-500 font-medium">Delta Optimized</p>
            <p className="text-[15px] font-bold text-slate-700 tabular-nums">{deltaEnergy} J</p>
          </div>
        </div>
      </div>
    </>
  )

  // ── Chart legend ───────────────────────────────────────────────────────
  const chartLegend = (compact: boolean) => (
    <div className={`flex flex-wrap items-center text-slate-500 ${compact ? 'gap-3 text-[10px] mt-1.5' : 'gap-4 text-xs mt-3'}`}>
      <div className="flex items-center gap-1.5">
        <div className={`${compact ? 'w-3' : 'w-5'} h-0.5 bg-emerald-500 rounded-full`} />
        <span>Moisture %</span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="9" height="9" viewBox="0 0 10 10"><polygon points="5,0 0,10 10,10" fill="#8b5cf6" /></svg>
        <span>Tx Event</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className={`${compact ? 'w-3 h-2' : 'w-5 h-3.5'} rounded-sm bg-slate-300/60 border border-dashed border-slate-400/50`} />
        <span>δ Band</span>
      </div>
    </div>
  )

  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="bg-slate-50 font-sans">

      {/* ████████████████████████████████████████████████████████████████
          MOBILE LAYOUT  (< lg) — single viewport, no scroll
      ████████████████████████████████████████████████████████████████ */}
      <div className="lg:hidden h-screen flex flex-col overflow-hidden">

        {/* Sticky header */}
        <header className="bg-white border-b border-slate-200 shadow-sm flex-shrink-0">
          <div className="p-3 flex flex-col gap-2">

            {/* Title + LIVE */}
            <div className="flex justify-between items-center">
              <h1 className="text-sm font-bold text-slate-700">IoT Soil Sim</h1>
              <div className="flex items-center gap-1.5 bg-slate-50 px-2.5 py-1 rounded-full border border-slate-200">
                <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-emerald-500 pulse-dot' : 'bg-slate-300'}`} />
                <span className="text-[10px] font-medium text-slate-700 uppercase tracking-wide">
                  {isPlaying ? 'Live' : isPaused ? 'Paused' : 'Idle'}
                </span>
              </div>
            </div>

            {/* Scenario segmented control */}
            <div className="flex bg-slate-100 p-1 rounded-lg gap-1">
              {SCENARIOS.map(({ key, shortLabel, icon }) => (
                <button
                  key={key} onClick={() => handleScenarioChange(key)}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-md
                    text-xs font-semibold transition-all ${
                    scenario === key
                      ? 'bg-white shadow-sm text-slate-700 border border-emerald-500'
                      : 'text-slate-500 border border-transparent'
                  }`}
                >
                  <span className={scenario === key ? 'text-emerald-500' : ''}>{icon}</span>
                  {shortLabel}
                </button>
              ))}
            </div>

            {/* Delta slider */}
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-slate-700 whitespace-nowrap">Delta (δ)</label>
              <input
                type="range" min="0" max="10" step="0.5" value={delta}
                onChange={e => setDelta(+e.target.value)}
                className="w-full h-1.5 rounded-full accent-emerald-500"
              />
              <span className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-700 border border-slate-200 whitespace-nowrap">
                {delta.toFixed(1)}%
              </span>
            </div>
          </div>
        </header>

        {/* Main — flex-col, chart fills remaining space */}
        <main className="flex-1 min-h-0 flex flex-col gap-2 p-3">

          {/* Chart card — flex-1 fills all available vertical space */}
          <div className="bg-white rounded-xl p-3 shadow-sm border border-slate-200 flex flex-col flex-1 min-h-0">
            <div className="flex justify-between items-start mb-2 flex-shrink-0">
              <div>
                <h3 className="text-sm font-semibold text-slate-700">Soil Moisture Stream</h3>
                <p className="text-[10px] text-slate-400">Volumetric Water Content (%)</p>
              </div>
              <button
                onClick={handleIrrigation}
                className="p-1.5 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 active:bg-emerald-100 transition-colors"
              >
                <Droplets size={16} />
              </button>
            </div>
            <div className="mb-2 flex-shrink-0">{playbackControls}</div>
            {/* Chart stretches to fill card */}
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={visibleData} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                  {lineChartInner}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-shrink-0">{chartLegend(true)}</div>
          </div>

          {/* Ambient cards — compact horizontal */}
          <div className="grid grid-cols-2 gap-2 flex-shrink-0">
            <div className="bg-white rounded-xl px-3 py-2.5 shadow-sm border border-slate-200 flex items-center justify-between">
              <div>
                <p className="text-[9px] font-semibold text-slate-500 mb-0.5">Temp</p>
                <p className="text-sm font-bold text-slate-700 tabular-nums">{liveTemp.toFixed(1)}°C</p>
              </div>
              <FlatSparkline seed={111} compact />
            </div>
            <div className="bg-white rounded-xl px-3 py-2.5 shadow-sm border border-slate-200 flex items-center justify-between">
              <div>
                <p className="text-[9px] font-semibold text-slate-500 mb-0.5">Humidity</p>
                <p className="text-sm font-bold text-slate-700">{liveHumidity}%</p>
              </div>
              <FlatSparkline seed={222} compact />
            </div>
          </div>

          {/* Compact scorecard — green card with key metrics */}
          <div className="bg-emerald-500 text-white rounded-xl px-4 py-3 flex items-center justify-between shadow-sm flex-shrink-0">
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-wider opacity-80">Packet Reduction</p>
              <p className="text-3xl font-bold tabular-nums leading-none mt-0.5">
                {reductionRatio}{reductionRatio !== '—' && <span className="text-xl font-normal">%</span>}
              </p>
            </div>
            <div className="text-xs text-right opacity-90 space-y-1.5">
              <div className="tabular-nums">
                SoD / <span key={`m-sod-${txFlashKey}`} className="font-bold sod-flash">
                  {sodCount}
                </span> pkt{sodCount !== 1 ? 's' : ''}
              </div>
              <div className="tabular-nums">
                <span key={`m-de-${txFlashKey}`} className="font-bold sod-flash">{deltaEnergy}</span> J vs 408.00 J
              </div>
            </div>
          </div>

          {/* Controls row: noise toggle + irrigation button */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <label className="flex-1 flex items-center justify-between bg-white rounded-xl px-3 py-2.5 shadow-sm border border-slate-200 cursor-pointer select-none">
              <span className="text-xs text-slate-700">Sensor Noise (±1.2%)</span>
              <NoiseToggle checked={noiseOn} onChange={setNoiseOn} />
            </label>
            <button
              onClick={handleIrrigation}
              className="bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white rounded-xl p-2.5 shadow-sm transition-all flex-shrink-0"
              title="Simulate Instant Irrigation"
            >
              <Droplets size={20} />
            </button>
          </div>

        </main>
      </div>

      {/* ████████████████████████████████████████████████████████████████
          DESKTOP LAYOUT  (≥ lg) — 3-column grid
      ████████████████████████████████████████████████████████████████ */}
      <div className="hidden lg:flex flex-col min-h-screen">

        <header className="px-6 pt-6">
          <h1 className="text-[1.35rem] font-bold text-slate-700 leading-snug">
            Indoor Prototype Simulator: Event-Driven Soil Moisture IoT Node
          </h1>
        </header>

        <main className="flex-1 grid grid-cols-12 gap-6 p-6 items-start">

          {/* ── Column 1: Control Cockpit ── */}
          <section className="col-span-3 flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={18} className="text-slate-500" />
              <h2 className="text-lg font-semibold text-slate-700">Control Cockpit</h2>
            </div>

            <div className="bg-white rounded-xl p-4 shadow-sm flex flex-col gap-2.5">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-0.5">Scenario Setup</p>
              {SCENARIOS.map(({ key, label, icon }) => (
                <ScenBtn key={key} active={scenario === key} label={label} icon={icon}
                  onClick={() => handleScenarioChange(key)} />
              ))}
            </div>

            <div className="bg-white rounded-xl p-5 shadow-sm flex flex-col gap-5">
              <div>
                <div className="flex justify-between items-center mb-3">
                  <label className="text-sm font-semibold text-slate-700">Delta Threshold (δ)</label>
                  <span className="bg-slate-100 px-2 py-0.5 rounded text-sm font-mono text-slate-600">{delta.toFixed(1)}%</span>
                </div>
                <input type="range" min="0" max="10" step="0.5" value={delta}
                  onChange={e => setDelta(+e.target.value)}
                  className="w-full h-1 rounded-full accent-emerald-500" />
                <div className="flex justify-between mt-1.5 text-[11px] text-slate-400 font-medium">
                  <span>0% (Continuous)</span><span>10% (Sparse)</span>
                </div>
              </div>
              <div className="h-px bg-slate-100" />
              <label className="flex items-center justify-between cursor-pointer select-none">
                <span className="text-sm text-slate-700">Simulate Sensor Noise (±1.2%)</span>
                <div className="relative flex-shrink-0">
                  <input type="checkbox" className="sr-only peer" checked={noiseOn} onChange={e => setNoiseOn(e.target.checked)} />
                  <div className="w-10 h-5 bg-slate-200 rounded-full peer peer-checked:bg-emerald-500
                    after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                    after:bg-white after:rounded-full after:h-4 after:w-4
                    after:transition-all peer-checked:after:translate-x-5" />
                </div>
              </label>
              <button onClick={handleIrrigation}
                className="w-full bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition-all">
                <Droplets size={15} /> Simulate Instant Irrigation
              </button>
            </div>
          </section>

          {/* ── Column 2: Live Telemetry ── */}
          <section className="col-span-6 flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <Activity size={18} className="text-emerald-500" />
              <h2 className="text-lg font-semibold text-slate-700">Live Telemetry Streams</h2>
            </div>

            <div className="bg-white rounded-xl p-6 shadow-sm">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-semibold text-slate-700">Soil Moisture</h3>
                  <p className="text-sm text-slate-400 mt-0.5">Real-time volumetric water content (%)</p>
                </div>
                <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                  <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-emerald-500 pulse-dot' : 'bg-slate-300'}`} />
                  <span className="text-xs font-medium text-slate-600">
                    {isPlaying ? 'Live' : isPaused ? 'Paused' : 'Idle'}
                  </span>
                </div>
              </div>
              <div className="mb-4">{playbackControls}</div>
              <ResponsiveContainer width="100%" height={236}>
                <LineChart data={visibleData} margin={{ top: 10, right: 10, left: -6, bottom: 0 }}>
                  {lineChartInner}
                </LineChart>
              </ResponsiveContainer>
              {chartLegend(false)}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-semibold text-slate-700">Ambient Temp</span>
                  <Thermometer size={15} className="text-slate-400" />
                </div>
                <div className="text-2xl font-bold text-slate-700">{liveTemp.toFixed(1)}°C</div>
                <FlatSparkline seed={111} />
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-sm font-semibold text-slate-700">Relative Humidity</span>
                  <Droplets size={15} className="text-slate-400" />
                </div>
                <div className="text-2xl font-bold text-slate-700">{liveHumidity}%</div>
                <FlatSparkline seed={222} />
              </div>
            </div>

            <p className="text-xs text-slate-400 italic px-1">
              "Microclimate parameters are retained locally and transmitted only during major delta events."
            </p>
          </section>

          {/* ── Column 3: Efficiency Scorecard ── */}
          <section className="col-span-3 flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <BatteryCharging size={18} className="text-emerald-500" />
              <h2 className="text-lg font-semibold text-slate-700">Efficiency Scorecard</h2>
            </div>
            {desktopScorecard}
          </section>

        </main>
      </div>

    </div>
  )
}
