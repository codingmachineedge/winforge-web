import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/HpcModule + HpcService: a supercomputer / HPC centre
// that is a heavy reactor-powered compute load. Online nodes scale with the
// reactor's available output (1 node / 2 MW, cap 5000). A job queue is drained
// while the reactor generates: work per tick = onlineNodes × dt node-hours.
// Standalone (available power is an operator slider vs the desktop reactor feed).

const MW_PER_NODE = 2;
const MAX_NODES = 5000;
const PFLOPS_PER_NODE = 0.002; // ~2 TFLOPS/node
const SIM_SECONDS_PER_TICK = 900; // compress time so jobs drain on a watchable scale
const TICK_MS = 500;

interface Job {
  id: number;
  name: string;
  total: number; // node-hours requested
  remaining: number;
}

interface State {
  availableMW: number;
  running: boolean;
  jobs: Job[];
  nodesOnline: number;
  pflops: number;
  completed: number;
  seq: number;
}

const SAMPLE_JOBS: Array<[string, number]> = [
  ['climate-model-v7', 400],
  ['protein-fold-batch', 260],
  ['cfd-wing-sweep', 320],
  ['llm-pretrain-shard', 600],
];

export function HpcModule() {
  const { t } = useTranslation();
  const [s, setS] = useState<State>({
    availableMW: 900,
    running: false,
    jobs: SAMPLE_JOBS.map(([name, total], i) => ({ id: i + 1, name, total, remaining: total })),
    nodesOnline: 0,
    pflops: 0,
    completed: 0,
    seq: SAMPLE_JOBS.length + 1,
  });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!s.running) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      setS((p) => {
        const generating = p.availableMW > 1;
        const nodes = generating ? Math.min(MAX_NODES, Math.floor(p.availableMW / MW_PER_NODE)) : 0;
        const pflops = nodes * PFLOPS_PER_NODE;
        if (!generating || nodes === 0) return { ...p, nodesOnline: 0, pflops: 0 };

        let budget = (nodes * SIM_SECONDS_PER_TICK) / 3600; // node-hours available this tick
        let completed = p.completed;
        const jobs = p.jobs.map((j) => ({ ...j }));
        for (const job of jobs) {
          if (budget <= 0) break;
          const need = Math.max(0, job.remaining);
          if (need <= 0) continue;
          if (budget >= need) {
            budget -= need;
            job.remaining = 0;
            completed += 1;
          } else {
            job.remaining = need - budget;
            budget = 0;
          }
        }
        const live = jobs.filter((j) => j.remaining > 0);
        return { ...p, nodesOnline: nodes, pflops, jobs: live, completed };
      });
    }, TICK_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [s.running]);

  const upd = (patch: Partial<State>) => setS((p) => ({ ...p, ...patch }));

  const submitJob = () => {
    const size = 200 + Math.floor((s.seq * 137) % 700);
    setS((p) => ({
      ...p,
      jobs: [...p.jobs, { id: p.seq, name: t('hpc.jobName', { n: p.seq }), total: size, remaining: size }],
      seq: p.seq + 1,
    }));
  };

  const queueDepth = s.jobs.reduce((sum, j) => sum + Math.max(0, j.remaining), 0);
  const status = !s.running
    ? t('hpc.idle')
    : s.nodesOnline === 0
      ? t('hpc.offline')
      : s.jobs.length === 0
        ? t('hpc.drained')
        : t('hpc.crunching', { nodes: s.nodesOnline });
  const fmt = (n: number) => new Intl.NumberFormat().format(Math.round(n));

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className={`mini${s.running ? '' : ' primary'}`} onClick={() => upd({ running: !s.running })}>
          {s.running ? t('hpc.stop') : t('hpc.start')}
        </button>
        <button className="mini" onClick={submitJob}>{t('hpc.submitJob')}</button>
        <StatusDot ok={s.running && s.nodesOnline > 0} label={status} />
      </ModuleToolbar>
      <p className="count-note">{t('hpc.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10 }}>
        <strong>{t('hpc.power')}</strong>
        <label style={{ display: 'block', margin: '8px 0' }}>
          {t('hpc.availableLabel', { mw: Math.round(s.availableMW) })}
          <input type="range" min={0} max={1150} value={s.availableMW} onChange={(e) => upd({ availableMW: Number(e.target.value) })} style={{ width: '100%' }} />
        </label>
      </div>

      <div className="panel" style={{ marginBottom: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Readout label={t('hpc.nodes')} value={`${fmt(s.nodesOnline)} / ${MAX_NODES}`} />
        <Readout label={t('hpc.pflops')} value={`${s.pflops.toFixed(2)} PFLOPS`} />
        <Readout label={t('hpc.queued')} value={`${s.jobs.length}`} />
        <Readout label={t('hpc.depth')} value={`${fmt(queueDepth)} node-h`} />
        <Readout label={t('hpc.completed')} value={`${s.completed}`} />
      </div>

      <div className="panel">
        <strong>{t('hpc.queue')}</strong>
        {s.jobs.length === 0 ? (
          <p className="count-note" style={{ marginBottom: 0 }}>{t('hpc.emptyQueue')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {s.jobs.map((j, i) => {
              const pct = j.total > 0 ? ((j.total - j.remaining) / j.total) * 100 : 100;
              return (
                <div key={j.id} className="panel" style={{ margin: 0, padding: '6px 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{i === 0 ? '▶ ' : ''}{j.name}</strong>
                    <span className="count-note" style={{ margin: 0 }}>{fmt(Math.max(0, j.remaining))} node-h · {pct.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 8, background: 'var(--bg-elevated)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel" style={{ margin: 0, padding: '8px 12px' }}>
      <div className="count-note" style={{ margin: 0 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
