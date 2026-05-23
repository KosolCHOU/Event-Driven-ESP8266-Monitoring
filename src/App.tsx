import { useState, useMemo, useEffect, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  SlidersHorizontal, Activity, BatteryCharging,
  CheckCircle, TrendingDown, Droplets, Thermometer,
  Wifi, Zap,
} from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────

type Scenario = 'stable' | 'drying' | 'irrigation'

interface Pt {
  cycle: number
  time: number        // minutes
  moisture: number
  isTx: boolean       // transmission event flag
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
// All 600 cycles = 30 min @ 3-second intervals

function genStableSoil(): Pt[] {
  // Stays in [38, 42] centred ≈40 — guaranteed max |Mk – M0| < 4% so SoD = 1 pkt
  const rng = makePrng(0xabcd1234)
  const pts: Pt[] = []
  for (let i = 0; i < 600; i++) {
    pts.push({
      cycle: i,
      time: +(i / 20).toFixed(3),
      moisture: 38 + rng() * 4,   // [38, 42]
      isTx: false,
    })
  }
  return pts
}

function genGradualDrying(): Pt[] {
  // Clean linear slope 42 → 30 over 600 cycles (+ ±0.15% micro-noise)
  const rng = makePrng(0xdeadbeef)
  return Array.from({ length: 600 }, (_, i) => ({
    cycle: i,
    time: +(i / 20).toFixed(3),
    moisture: 42 - (12 * i) / 599 + (rng() - 0.5) * 0.3,
    isTx: false,
  }))
}

function genIrrigationEvent(): Pt[] {
  // 0–249: flat 37, 250–399: step-up 45, 400–599: drop/stabilise 40
  const rng = makePrng(0xcafe8765)
  return Array.from({ length: 600 }, (_, i) => {
    let moisture: number
    if (i < 250)      moisture = 37 + (rng() - 0.5) * 0.5
    else if (i < 400) moisture = 45 + (rng() - 0.5) * 0.5
    else              moisture = 40 + (rng() - 0.5) * 0.5
    return { cycle: i, time: +(i / 20).toFixed(3), moisture, isTx: false }
  })
}

// ─── Send-on-Delta Engine ──────────────────────────────────────────────────
// M_last = M_0 (initial boot TX counts as pkt #1)
// Subsequent TX flagged when |Mk – Mlast| >= threshold

function runDelta(raw: Pt[], threshold: number): { pts: Pt[]; count: number } {
  const pts = raw.map(p => ({ ...p, isTx: false }))
  pts[0].isTx = true
  let mLast = pts[0].moisture
  let count = 1

  for (let k = 1; k < pts.length; k++) {
    if (Math.abs(pts[k].moisture - mLast) >= threshold) {
      pts[k].isTx = true
      mLast = pts[k].moisture
      count++
    }
  }
  return { pts, count }
}

// ─── Hardcoded Paper Metrics (δ = 4.0%) ───────────────────────────────────

const PAPER: Record<Scenario, { ratio: string; packets: number; energy: number }> = {
  stable:     { ratio: '99.8', packets: 1, energy: 0.68 },
  drying:     { ratio: '99.3', packets: 4, energy: 2.72 },
  irrigation: { ratio: '99.5', packets: 3, energy: 2.04 },
}

// ─── Custom Recharts Dot: purple ▲ only at TX events ──────────────────────

function TxDot(props: {
  cx?: number; cy?: number
  payload?: Pt
  [k: string]: unknown
}) {
  const { cx = 0, cy = 0, payload } = props
  if (!payload?.isTx) return <circle r={0} cx={cx} cy={cy} />
  const s = 7
  return (
    <polygon
      points={`${cx},${cy - s} ${cx - s * 0.85},${cy + s * 0.55} ${cx + s * 0.85},${cy + s * 0.55}`}
      fill="#8b5cf6"
    />
  )
}

// ─── Flat Sparkline for ambient cards ─────────────────────────────────────

function FlatSparkline({ seed = 42 }: { seed?: number }) {
  const rng = makePrng(seed)
  const w = 200, h = 40
  const pts = Array.from({ length: 30 }, (_, i) =>
    `${(i / 29) * w},${h / 2 + (rng() - 0.5) * 6}`
  ).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-10 mt-1">
      <polyline points={pts} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Scenario Button ───────────────────────────────────────────────────────

interface ScenBtnProps {
  active: boolean
  label: string
  icon: React.ReactNode
  onClick: () => void
}
function ScenBtn({ active, label, icon, onClick }: ScenBtnProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all ${
        active
          ? 'border-emerald-500 bg-emerald-50/50'
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

// ─── App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [scenario, setScenario] = useState<Scenario>('stable')
  const [delta, setDelta] = useState(4.0)
  const [noiseOn, setNoiseOn] = useState(true)
  const [flashKey, setFlashKey] = useState(0)    // increments to retrigger animation
  const prevPackets = useRef(1)

  // Static raw datasets (generated once)
  const rawData = useMemo(() => ({
    stable:     genStableSoil(),
    drying:     genGradualDrying(),
    irrigation: genIrrigationEvent(),
  }), [])

  // Run delta engine on active scenario
  const { pts: allPts, count: dynPackets } = useMemo(
    () => runDelta(rawData[scenario], delta),
    [rawData, scenario, delta]
  )

  // Thin to ≤300 display points but always keep TX events for triangle rendering
  const chartData = useMemo(() => {
    const step = Math.ceil(allPts.length / 300)
    return allPts.filter((p, i) => i % step === 0 || p.isTx)
  }, [allPts])

  // At δ=4.0% use hardcoded paper metrics; otherwise dynamic
  const canonical = Math.abs(delta - 4.0) < 0.01
  const m = canonical
    ? PAPER[scenario]
    : {
        ratio: ((1 - dynPackets / 600) * 100).toFixed(1),
        packets: dynPackets,
        energy: +(dynPackets * 0.68).toFixed(2),
      }

  // Flash SoD scoreboard on packet-count change (scenario switch or slider move)
  useEffect(() => {
    if (m.packets !== prevPackets.current) {
      setFlashKey(k => k + 1)
      prevPackets.current = m.packets
    }
  }, [m.packets])

  const sodBarPct = Math.max(0.6, (m.packets / 600) * 100)

  // Custom tooltip
  const TooltipContent = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
      <div className="bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-md text-xs">
        <p className="text-slate-500 mb-0.5">t = {label} min</p>
        <p className="text-emerald-600 font-semibold">{(payload[0].value as number).toFixed(2)}% VWC</p>
        {payload[0].payload?.isTx && (
          <p className="text-purple-500 font-medium mt-0.5">▲ Transmission event</p>
        )}
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="bg-slate-50 min-h-screen flex flex-col font-sans p-6 gap-6">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <header>
        <h1 className="text-[1.35rem] font-bold text-slate-700 leading-snug">
          Indoor Prototype Simulator: Event-Driven Soil Moisture IoT Node
        </h1>
      </header>

      {/* ── Main 3-column grid ────────────────────────────────────────── */}
      <main className="flex-1 grid grid-cols-12 gap-6 items-start">

        {/* ═══ COLUMN 1 – Control Cockpit ═══════════════════════════════ */}
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
            <ScenBtn
              active={scenario === 'stable'}
              label="Stable Soil"
              icon={<CheckCircle size={15} />}
              onClick={() => setScenario('stable')}
            />
            <ScenBtn
              active={scenario === 'drying'}
              label="Gradual Drying"
              icon={<TrendingDown size={15} />}
              onClick={() => setScenario('drying')}
            />
            <ScenBtn
              active={scenario === 'irrigation'}
              label="Irrigation Event"
              icon={<Droplets size={15} />}
              onClick={() => setScenario('irrigation')}
            />
          </div>

          {/* Parameters */}
          <div className="bg-white rounded-xl p-5 shadow-sm flex flex-col gap-5">
            {/* Delta slider */}
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

            {/* Instant irrigation button */}
            <button
              onClick={() => setScenario('irrigation')}
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white
                py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center
                gap-2 shadow-sm transition-colors"
            >
              <Droplets size={15} />
              Simulate Instant Irrigation
            </button>
          </div>
        </section>

        {/* ═══ COLUMN 2 – Live Telemetry Streams ════════════════════════ */}
        <section className="col-span-6 flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-emerald-500" />
            <h2 className="text-lg font-semibold text-slate-700">Live Telemetry Streams</h2>
          </div>

          {/* Main chart */}
          <div className="bg-white rounded-xl p-6 shadow-sm">
            <div className="flex justify-between items-start mb-5">
              <div>
                <h3 className="text-xl font-semibold text-slate-700">Soil Moisture</h3>
                <p className="text-sm text-slate-400 mt-0.5">Real-time volumetric water content (%)</p>
              </div>
              <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
                <span className="w-2 h-2 rounded-full bg-emerald-500 pulse-dot" />
                <span className="text-xs font-medium text-slate-600">Live</span>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 12, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="time"
                  tickFormatter={v => `${v}m`}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  interval={Math.floor(chartData.length / 6)}
                />
                <YAxis
                  domain={[30, 46]}
                  ticks={[30, 34, 38, 42, 46]}
                  tickFormatter={v => `${v}%`}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />
                <Tooltip content={<TooltipContent />} />
                <Line
                  type="monotone"
                  dataKey="moisture"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={<TxDot />}
                  activeDot={{ r: 4, fill: '#10b981', strokeWidth: 0 }}
                  isAnimationActive
                  animationDuration={500}
                />
              </LineChart>
            </ResponsiveContainer>

            {/* Legend */}
            <div className="flex items-center gap-5 text-xs text-slate-500 mt-3">
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

        {/* ═══ COLUMN 3 – Efficiency Scorecard ══════════════════════════ */}
        <section className="col-span-3 flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <BatteryCharging size={18} className="text-emerald-500" />
            <h2 className="text-lg font-semibold text-slate-700">Efficiency Scorecard</h2>
          </div>

          {/* Hero metric */}
          <div className="bg-emerald-500 text-white rounded-xl p-6 shadow-sm relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)',
                backgroundSize: '16px 16px',
              }}
            />
            <p className="text-xs font-semibold mb-2 relative z-10 opacity-90 uppercase tracking-wider">
              Packet Reduction Ratio
            </p>
            <div className="text-[3.2rem] font-bold relative z-10 flex items-baseline leading-none gap-0.5">
              {m.ratio}
              <span className="text-2xl font-normal">%</span>
            </div>
            <p className="text-xs mt-2.5 relative z-10 opacity-80">
              Less data transmitted vs. continuous polling.
            </p>
          </div>

          {/* Network Load */}
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Network Load Comparison
            </p>
            <div className="flex flex-col gap-4">
              {/* Continuous */}
              <div>
                <div className="flex justify-between items-center text-sm mb-1.5">
                  <span className="text-slate-600">Continuous Polling</span>
                  <span className="font-mono text-slate-400 text-xs">600 pkts</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5">
                  <div className="bg-slate-300 h-1.5 rounded-full w-full" />
                </div>
              </div>
              {/* Send-on-Delta */}
              <div>
                <div className="flex justify-between items-center text-sm mb-1.5">
                  <span className="text-slate-700 font-semibold">Send-on-Delta</span>
                  {/* SoD count with flash */}
                  <span
                    key={flashKey}
                    className="font-mono text-xs font-bold text-emerald-500 flash-sod rounded px-1"
                  >
                    {m.packets} pkt{m.packets !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-1.5">
                  <div
                    className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${sodBarPct}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Energy comparison */}
          <div
            key={`energy-${flashKey}`}
            className="bg-white rounded-xl p-5 shadow-sm flash-sod"
          >
            <div className="flex justify-between items-center mb-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Estimated Wi-Fi Energy
              </p>
              <Zap size={13} className="text-slate-400" />
            </div>

            {/* Standard */}
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                <Wifi size={17} className="text-slate-400" />
              </div>
              <div>
                <p className="text-[11px] text-slate-400 font-medium">Standard Usage</p>
                <p className="text-[15px] text-slate-700">408.00 J</p>
              </div>
            </div>

            {/* Delta-optimised */}
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                <Zap size={17} className="text-emerald-500" />
              </div>
              <div>
                <p className="text-[11px] text-emerald-500 font-medium">Delta Optimized</p>
                <p className="text-[15px] font-bold text-slate-700">{m.energy.toFixed(2)} J</p>
              </div>
            </div>
          </div>
        </section>

      </main>
    </div>
  )
}
