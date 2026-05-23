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
  time:     number   // minutes (0–30)
  moisture: number   // % VWC
  isTx:     boolean  // flagged as a Send-on-Delta transmission
}

// ─── Deterministic PRNG (LCG) ──────────────────────────────────────────────

function makePrng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// ─── Dataset Generation  (600 pts = 30 min @ 3-second cycles) ─────────────

function genStableSoil(): Pt[] {
  const rng = makePrng(0xabcd1234)
  return Array.from({ length: 600 }, (_, i) => ({
    cycle: i, time: +(i / 20).toFixed(3),
    moisture: 38 + rng() * 4,
    isTx: false,
  }))
}

function genGradualDrying(): Pt[] {
  const rng = makePrng(0xdeadbeef)
  return Array.from({ length: 600 }, (_, i) => ({
    cycle: i, time: +(i / 20).toFixed(3),
    moisture: 42 - (12 * i) / 599 + (rng() - 0.5) * 0.3,
    isTx: false,
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

// ─── Custom Recharts Dot — purple ▲ only on TX events ─────────────────────

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

function FlatSparkline({ seed }: { seed: number }) {
  const rng = makePrng(seed)
  const pts = Array.from({ length: 30 }, (_, i) =>
    `${(i / 29) * 200},${20 + (rng() - 0.5) * 6}`
  ).join(' ')
  return (
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="w-full h-10 mt-1">
      <polyline points={pts} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Scenario Button ───────────────────────────────────────────────────────

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
      <span className={`text-sm font-semibold ${active ? 'text-slate-700' : 'text-slate-500'}`}>
        {label}
      </span>
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
      {p.payload?.isTx && (
        <p className="text-purple-500 font-medium mt-0.5">▲ Transmission event</p>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  App
// ═══════════════════════════════════════════════════════════════════════════

const TICK_MS = 50   // interval heartbeat

export default function App() {
  // ── UI State ──────────────────────────────────────────────────────────
  const [scenario,      setScenario]      = useState<Scenario>('stable')
  const [delta,         setDelta]         = useState(4.0)
  const [noiseOn,       setNoiseOn]       = useState(true)
  const [isPlaying,     setIsPlaying]     = useState(false)
  const [currentIndex,  setCurrentIndex]  = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1)

  // ── Stream State (rendered) ────────────────────────────────────────────
  const [visibleData,  setVisibleData]  = useState<Pt[]>([])
  const [mLast,        setMLast]        = useState(0)
  const [sodCount,     setSodCount]     = useState(0)
  const [txFlashKey,   setTxFlashKey]   = useState(0)

  // ── Refs (stable inside setInterval closures) ──────────────────────────
  const intervalRef        = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentIndexRef    = useRef(0)
  const mLastRef           = useRef(0)
  const sodCountRef        = useRef(0)
  const deltaRef           = useRef(delta)
  const playbackSpeedRef   = useRef<number>(1)
  const isPlayingRef       = useRef(false)
  const activeDataRef      = useRef<Pt[]>([])
  const autoRestartRef     = useRef(false)

  // ── Raw datasets (generated once) ─────────────────────────────────────
  const rawData = useMemo(() => ({
    stable:     genStableSoil(),
    drying:     genGradualDrying(),
    irrigation: genIrrigationEvent(),
  }), [])

  // Keep refs in sync with latest React state
  useEffect(() => { deltaRef.current        = delta        }, [delta])
  useEffect(() => { playbackSpeedRef.current = playbackSpeed }, [playbackSpeed])

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
        stopInterval()
        setIsPlaying(false)
        isPlayingRef.current = false
        return
      }

      const newPts: Pt[] = []
      let txOccurred = false

      for (
        let i = 0;
        i < playbackSpeedRef.current && currentIndexRef.current < activeDataRef.current.length;
        i++
      ) {
        const idx = currentIndexRef.current
        const raw = activeDataRef.current[idx]
        const pt: Pt = { ...raw, isTx: false }

        if (idx === 0) {
          pt.isTx             = true
          mLastRef.current    = pt.moisture
          sodCountRef.current = 1
          txOccurred          = true
        } else if (Math.abs(pt.moisture - mLastRef.current) >= deltaRef.current) {
          pt.isTx             = true
          mLastRef.current    = pt.moisture
          sodCountRef.current++
          txOccurred          = true
        }

        newPts.push(pt)
        currentIndexRef.current++
      }

      setVisibleData(prev => [...prev, ...newPts])
      setCurrentIndex(currentIndexRef.current)
      setMLast(mLastRef.current)
      setSodCount(sodCountRef.current)
      if (txOccurred) setTxFlashKey(k => k + 1)
    }, TICK_MS)
  }, [stopInterval])

  // ── Scenario change: full reset + optional auto-restart ────────────────
  useEffect(() => {
    const shouldRestart = autoRestartRef.current
    autoRestartRef.current = false

    stopInterval()
    currentIndexRef.current = 0
    mLastRef.current        = 0
    sodCountRef.current     = 0
    setVisibleData([])
    setCurrentIndex(0)
    setMLast(0)
    setSodCount(0)
    setIsPlaying(false)
    isPlayingRef.current = false

    activeDataRef.current = rawData[scenario].map(p => ({ ...p }))

    if (shouldRestart) {
      const t = setTimeout(() => {
        setIsPlaying(true)
        isPlayingRef.current = true
        startInterval()
      }, 60)
      return () => clearTimeout(t)
    }
  }, [scenario, rawData, stopInterval, startInterval])

  // Cleanup on unmount
  useEffect(() => () => stopInterval(), [stopInterval])

  // ── Playback handlers ──────────────────────────────────────────────────

  const handleScenarioChange = (s: Scenario) => {
    if (isPlayingRef.current) autoRestartRef.current = true
    setScenario(s)
  }

  const handlePlay = () => {
    if (currentIndexRef.current >= activeDataRef.current.length) {
      currentIndexRef.current = 0
      mLastRef.current        = 0
      sodCountRef.current     = 0
      setVisibleData([])
      setCurrentIndex(0)
      setMLast(0)
      setSodCount(0)
    }
    setIsPlaying(true)
    isPlayingRef.current = true
    startInterval()
  }

  const handlePause = () => {
    stopInterval()
    setIsPlaying(false)
    isPlayingRef.current = false
  }

  const handleReset = () => {
    stopInterval()
    currentIndexRef.current = 0
    mLastRef.current        = 0
    sodCountRef.current     = 0
    setVisibleData([])
    setCurrentIndex(0)
    setMLast(0)
    setSodCount(0)
    setIsPlaying(false)
    isPlayingRef.current = false
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
      setIsPlaying(true)
      isPlayingRef.current = true
      startInterval()
    }
  }

  // ── Derived metrics ────────────────────────────────────────────────────
  const totalStreamed  = visibleData.length
  const progressPct   = Math.min(100, (totalStreamed / 600) * 100)

  const reductionRatio =
    sodCount > 0
      ? ((1 - sodCount / 600) * 100).toFixed(1)
      : totalStreamed > 0 ? '100.0' : '—'

  const continuousEnergy = (totalStreamed * 0.68).toFixed(2)
  const deltaEnergy      = (sodCount * 0.68).toFixed(2)
  const sodBarPct   = Math.max(0.5, (sodCount / 600) * 100)

  const showBand = totalStreamed > 0 && mLast > 0
  const bandY1   = Math.max(30, mLast - delta)
  const bandY2   = Math.min(46, mLast + delta)

  // Derived display state
  const isPaused = !isPlaying && currentIndex > 0

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="bg-slate-50 min-h-screen flex flex-col font-sans p-6 gap-6">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header>
        <h1 className="text-[1.35rem] font-bold text-slate-700 leading-snug">
          Indoor Prototype Simulator: Event-Driven Soil Moisture IoT Node
        </h1>
      </header>

      {/* ── 3-column grid ───────────────────────────────────────────────── */}
      <main className="flex-1 grid grid-cols-12 gap-6 items-start">

        {/* ══════════════════════════════════════════
            COLUMN 1 — Control Cockpit  (3/12)
        ══════════════════════════════════════════ */}
        <section className="col-span-3 flex flex-col gap-5">

          <div className="flex items-center gap-2">
            <SlidersHorizontal size={18} className="text-slate-500" />
            <h2 className="text-lg font-semibold text-slate-700">Control Cockpit</h2>
          </div>

          {/* Scenario cards */}
          <div className="bg-white rounded-xl p-4 shadow-sm flex flex-col gap-2.5">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-0.5">
              Scenario Setup
            </p>
            <ScenBtn active={scenario === 'stable'}     label="Stable Soil"      icon={<CheckCircle size={15} />} onClick={() => handleScenarioChange('stable')} />
            <ScenBtn active={scenario === 'drying'}     label="Gradual Drying"   icon={<TrendingDown size={15} />} onClick={() => handleScenarioChange('drying')} />
            <ScenBtn active={scenario === 'irrigation'} label="Irrigation Event" icon={<Droplets size={15} />}    onClick={() => handleScenarioChange('irrigation')} />
          </div>

          {/* Parameters */}
          <div className="bg-white rounded-xl p-5 shadow-sm flex flex-col gap-5">

            {/* δ slider */}
            <div>
              <div className="flex justify-between items-center mb-3">
                <label className="text-sm font-semibold text-slate-700">Delta Threshold (δ)</label>
                <span className="bg-slate-100 px-2 py-0.5 rounded text-sm font-mono text-slate-600">
                  {delta.toFixed(1)}%
                </span>
              </div>
              <input
                type="range" min="0" max="10" step="0.5" value={delta}
                onChange={e => setDelta(+e.target.value)}
                className="w-full h-1 rounded-full accent-emerald-500"
              />
              <div className="flex justify-between mt-1.5 text-[11px] text-slate-400 font-medium">
                <span>0% (Continuous)</span>
                <span>10% (Sparse)</span>
              </div>
            </div>

            <div className="h-px bg-slate-100" />

            {/* Noise toggle */}
            <label className="flex items-center justify-between cursor-pointer select-none">
              <span className="text-sm text-slate-700">Simulate Sensor Noise (±1.2%)</span>
              <div className="relative flex-shrink-0">
                <input
                  type="checkbox" className="sr-only peer"
                  checked={noiseOn} onChange={e => setNoiseOn(e.target.checked)}
                />
                <div className="w-10 h-5 bg-slate-200 rounded-full peer peer-checked:bg-emerald-500
                  after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                  after:bg-white after:rounded-full after:h-4 after:w-4
                  after:transition-all peer-checked:after:translate-x-5" />
              </div>
            </label>

            {/* Irrigation button */}
            <button
              onClick={handleIrrigation}
              className="w-full bg-emerald-500 hover:bg-emerald-600 active:scale-95
                text-white py-2.5 rounded-lg text-sm font-semibold
                flex items-center justify-center gap-2 shadow-sm transition-all"
            >
              <Droplets size={15} />
              Simulate Instant Irrigation
            </button>
          </div>
        </section>

        {/* ══════════════════════════════════════════
            COLUMN 2 — Live Telemetry  (6/12)
        ══════════════════════════════════════════ */}
        <section className="col-span-6 flex flex-col gap-5">

          <div className="flex items-center gap-2">
            <Activity size={18} className="text-emerald-500" />
            <h2 className="text-lg font-semibold text-slate-700">Live Telemetry Streams</h2>
          </div>

          {/* Chart card */}
          <div className="bg-white rounded-xl p-6 shadow-sm">

            {/* Card header */}
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-700">Soil Moisture</h3>
                <p className="text-sm text-slate-400 mt-0.5">Real-time volumetric water content (%)</p>
              </div>
              <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                <span className={`w-2 h-2 rounded-full ${
                  isPlaying ? 'bg-emerald-500 pulse-dot' : 'bg-slate-300'
                }`} />
                <span className="text-xs font-medium text-slate-600">
                  {isPlaying ? 'Live' : isPaused ? 'Paused' : 'Idle'}
                </span>
              </div>
            </div>

            {/* ── Playback Controls ──────────────────────────────────── */}
            <div className="flex items-center gap-2 mb-4">
              {/* Play / Pause */}
              <button
                onClick={isPlaying ? handlePause : handlePlay}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                  transition-all active:scale-95 ${
                  isPlaying
                    ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    : 'bg-emerald-500 text-white hover:bg-emerald-600'
                }`}
              >
                {isPlaying
                  ? <><Pause size={11} /> Pause</>
                  : <><Play  size={11} /> {isPaused ? 'Resume' : 'Play'}</>
                }
              </button>

              {/* Reset */}
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                  bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all active:scale-95"
              >
                <RotateCcw size={11} /> Reset
              </button>

              <div className="w-px h-4 bg-slate-200 mx-0.5" />

              {/* Speed selector — segmented control */}
              <div className="flex rounded-md overflow-hidden border border-slate-200">
                {([1, 5, 10] as PlaybackSpeed[]).map((s, i) => (
                  <button
                    key={s}
                    onClick={() => setPlaybackSpeed(s)}
                    className={`px-2.5 py-1.5 text-xs font-mono font-bold transition-all
                      ${i > 0 ? 'border-l border-slate-200' : ''}
                      ${playbackSpeed === s
                        ? 'bg-slate-700 text-white'
                        : 'bg-white text-slate-500 hover:bg-slate-50'
                      }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>

              {/* Progress bar */}
              <div className="flex-1 flex items-center gap-2 ml-1">
                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 rounded-full transition-all duration-75"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-slate-400 w-7 text-right tabular-nums">
                  {Math.round(progressPct)}%
                </span>
              </div>
            </div>

            {/* ── Recharts Line Chart ──────────────────────────────────── */}
            <ResponsiveContainer width="100%" height={236}>
              <LineChart
                data={visibleData}
                margin={{ top: 10, right: 10, left: -6, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />

                <XAxis
                  dataKey="time"
                  type="number"
                  domain={[0, 30]}
                  ticks={[0, 5, 10, 15, 20, 25, 30]}
                  tickFormatter={v => `${v}m`}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />

                <YAxis
                  domain={[30, 46]}
                  allowDataOverflow={true}
                  ticks={[30, 34, 38, 42, 46]}
                  tickFormatter={v => `${v}%`}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />

                <Tooltip content={<ChartTooltip />} />

                {/* ── Live δ threshold band ──────────────────────────── */}
                {showBand && (
                  <ReferenceArea
                    y1={bandY1}
                    y2={bandY2}
                    fill="#94a3b8"
                    fillOpacity={0.13}
                    stroke="#94a3b8"
                    strokeOpacity={0.3}
                    strokeWidth={0.75}
                    strokeDasharray="4 3"
                    ifOverflow="hidden"
                  />
                )}

                <Line
                  type="monotone"
                  dataKey="moisture"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={<TxDot />}
                  activeDot={{ r: 4, fill: '#10b981', strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 mt-3">
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-0.5 bg-emerald-500 rounded-full" />
                <span>Moisture %</span>
              </div>
              <div className="flex items-center gap-1.5">
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <polygon points="5,0 0,10 10,10" fill="#8b5cf6" />
                </svg>
                <span>Transmission Event</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-5 h-3.5 rounded-sm bg-slate-300/60 border border-dashed border-slate-400/50" />
                <span>δ Threshold Band</span>
              </div>
            </div>
          </div>

          {/* Ambient mini-cards */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <div className="flex justify-between items-center mb-1">
                <span className="text-sm font-semibold text-slate-700">Ambient Temp</span>
                <Thermometer size={15} className="text-slate-400" />
              </div>
              <div className="text-2xl font-bold text-slate-700">30.8°C</div>
              <FlatSparkline seed={111} />
            </div>
            <div className="bg-white rounded-xl p-4 shadow-sm">
              <div className="flex justify-between items-center mb-1">
                <span className="text-sm font-semibold text-slate-700">Relative Humidity</span>
                <Droplets size={15} className="text-slate-400" />
              </div>
              <div className="text-2xl font-bold text-slate-700">48%</div>
              <FlatSparkline seed={222} />
            </div>
          </div>

          <p className="text-xs text-slate-400 italic px-1">
            "Microclimate parameters are retained locally and transmitted only during major delta events."
          </p>
        </section>

        {/* ══════════════════════════════════════════
            COLUMN 3 — Efficiency Scorecard  (3/12)
        ══════════════════════════════════════════ */}
        <section className="col-span-3 flex flex-col gap-5">

          <div className="flex items-center gap-2">
            <BatteryCharging size={18} className="text-emerald-500" />
            <h2 className="text-lg font-semibold text-slate-700">Efficiency Scorecard</h2>
          </div>

          {/* Hero — Packet Reduction Ratio */}
          <div className="bg-emerald-500 text-white rounded-xl p-6 shadow-sm relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)',
                backgroundSize: '16px 16px',
              }}
            />
            <p className="text-[10px] font-semibold mb-2 relative z-10 opacity-90 uppercase tracking-wider">
              Packet Reduction Ratio
            </p>
            <div className="text-[3.2rem] font-bold relative z-10 flex items-baseline leading-none gap-0.5 tabular-nums">
              {reductionRatio}
              {reductionRatio !== '—' && <span className="text-2xl font-normal">%</span>}
            </div>
            <p className="text-xs mt-2.5 relative z-10 opacity-80">
              Less data transmitted vs. continuous polling.
            </p>
          </div>

          {/* Network Load Comparison */}
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Network Load Comparison
            </p>
            <div className="flex flex-col gap-4">

              {/* Continuous */}
              <div>
                <div className="flex justify-between items-center text-sm mb-1.5">
                  <span className="text-slate-600">Continuous Polling</span>
                  <span
                    key={`cp-${totalStreamed}`}
                    className="font-mono text-slate-400 text-xs ref-flash tabular-nums"
                  >
                    {totalStreamed} pkts
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5">
                  <div className="bg-slate-300 h-1.5 rounded-full w-full" />
                </div>
              </div>

              {/* Send-on-Delta — flashes on TX event */}
              <div>
                <div className="flex justify-between items-center text-sm mb-1.5">
                  <span className="text-slate-700 font-semibold">Send-on-Delta</span>
                  <span
                    key={`sod-${txFlashKey}`}
                    className="font-mono text-xs font-bold text-emerald-500 sod-flash tabular-nums"
                  >
                    {sodCount} pkt{sodCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5">
                  <div
                    className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${sodBarPct}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Energy card — pulse + glow on TX event */}
          <div
            key={`energy-${txFlashKey}`}
            className="bg-white rounded-xl p-5 shadow-sm tx-pop"
            style={{ transformOrigin: 'center' }}
          >
            <div className="flex justify-between items-center mb-4">
              <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Estimated Wi-Fi Energy
              </p>
              <Zap size={13} className="text-slate-400" />
            </div>

            {/* Standard Usage */}
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                <Wifi size={17} className="text-slate-400" />
              </div>
              <div>
                <p className="text-[11px] text-slate-400 font-medium">Standard Usage</p>
                <p
                  key={`su-${totalStreamed}`}
                  className="text-[15px] text-slate-700 ref-flash tabular-nums"
                >
                  {continuousEnergy} J
                </p>
              </div>
            </div>

            {/* Delta Optimised */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                <Zap size={17} className="text-emerald-500" />
              </div>
              <div>
                <p className="text-[11px] text-emerald-500 font-medium">Delta Optimized</p>
                <p className="text-[15px] font-bold text-slate-700 tabular-nums">
                  {deltaEnergy} J
                </p>
              </div>
            </div>
          </div>

        </section>
      </main>
    </div>
  )
}
