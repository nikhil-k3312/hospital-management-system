"""Paper figures from the decision-model experiments (print, light surface)."""
import os, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decision_model as m

OUT = m.OUT
plt.rcParams.update({'font.family': 'serif', 'font.serif': ['STIXGeneral'], 'mathtext.fontset': 'stix',
                     'font.size': 8, 'axes.edgecolor': '#8a8a85', 'axes.linewidth': 0.6,
                     'xtick.color': '#3d3d3a', 'ytick.color': '#3d3d3a', 'axes.labelcolor': '#0b0b0b'})
INK, MUTED, GRID = '#0b0b0b', '#6b6b66', '#e6e5e0'
S1, S2, S3 = '#2a78d6', '#eb6834', '#1baf7a'           # categorical slots 1-3

# ---------- Fig. 2: password-only share for returning users ----------
roles = ['patient', 'insurance', 'doctor', 'admin']
labels = ['Patient', 'Insurance', 'Doctor', 'Admin']
def pw_only(th, gate, role):
    return 100 * sum(m.tier(m.score(c), c[1], role, th, gate, c[4]) == 'low' for c in m.RETURNING) / len(m.RETURNING)
series = [('B1 static 2FA', [0, 0, 0, 0], S1),
          ('B2 Version 3 (80/50)', [pw_only(m.UNIFORM, False, r) for r in roles], S2),
          ('CARMA', [pw_only(m.ROLE_T, True, r) for r in roles], S3)]
fig, ax = plt.subplots(figsize=(3.45, 2.1), dpi=300)
bw, gap = 0.26, 0.02
for i, (name, vals, col) in enumerate(series):
    xs = [k + (i - 1) * (bw + gap) for k in range(4)]
    ax.bar(xs, vals, width=bw, color=col, label=name, zorder=3)
    for x, v in zip(xs, vals):
        ax.text(x, v + 1.5, f'{v:.0f}', ha='center', va='bottom', fontsize=6, color=INK if i == 2 else MUTED)
ax.set_xticks(range(4)); ax.set_xticklabels(labels)
ax.set_ylim(0, 100); ax.set_ylabel('Password-only logins (%)')
ax.yaxis.grid(True, color=GRID, lw=0.6, zorder=0); ax.set_axisbelow(True)
for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
ax.legend(frameon=False, fontsize=6.5, loc='upper right', ncol=1, handlelength=1.2)
fig.tight_layout(pad=0.3)
fig.savefig(os.path.join(OUT, 'fig2_friction.png')); plt.close(fig)

# ---------- Fig. 3: trust score surface, trusted vs new device ----------
locs = ['near', 'mid', 'unknown', 'far']
loc_lab = ['< 50 km', '50-350 km', 'withheld', '>= 350 km']
nets = ['hospital', 'known', 'new']
net_lab = ['Hospital', 'Known', 'New']
cmap = LinearSegmentedColormap.from_list('blue', ['#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'])
fig, axes = plt.subplots(1, 2, figsize=(3.45, 1.85), dpi=300, sharey=True)
for ax, dev, title in zip(axes, ['trusted', 'new'], ['Trusted device', 'New device']):
    Z = [[m.score((l, dev, 'duty', n, 0)) for n in nets] for l in locs]
    im = ax.imshow(Z, cmap=cmap, vmin=0, vmax=100, aspect='auto')
    for i, l in enumerate(locs):
        for j, n in enumerate(nets):
            v = Z[i][j]
            t = m.tier(v, dev, 'doctor', m.ROLE_T, True, 0)
            ax.text(j, i, f'{v:.0f}\n{t}', ha='center', va='center', fontsize=5.6,
                    color='#ffffff' if v >= 60 else INK)
    ax.set_xticks(range(3)); ax.set_xticklabels(net_lab, fontsize=6.5)
    ax.set_title(title, fontsize=7.5, color=INK, pad=3)
    for sp in ax.spines.values(): sp.set_visible(False)
    ax.tick_params(length=0); ax.tick_params(which='minor', length=0)
    ax.set_xticks([x - 0.5 for x in range(1, 3)], minor=True)
    ax.set_yticks([y - 0.5 for y in range(1, 4)], minor=True)
    ax.grid(which='minor', color='#ffffff', lw=1.5)
axes[0].set_yticks(range(4)); axes[0].set_yticklabels(loc_lab, fontsize=6.5)
axes[0].set_ylabel('IP-to-GPS distance', fontsize=7)
fig.text(0.6, 0.01, 'Network of origin', ha='center', fontsize=7)
fig.tight_layout(pad=0.3, rect=(0, 0.05, 1, 1))
fig.savefig(os.path.join(OUT, 'fig3_score_surface.png')); plt.close(fig)
print('figures written')
