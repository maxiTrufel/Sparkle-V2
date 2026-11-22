import numpy as np, matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
rng=np.random.default_rng(42); b=3.21; UMBRAL=20.; FRAC=.30; N=300
def pf(f,d,reps=8000):
    k=int(round(f*N))
    t=np.concatenate([np.full((reps,k),d),np.full((reps,N-k),3.0)],axis=1)
    m=t+rng.laplace(0,b,size=t.shape)
    return ((np.abs(m)>UMBRAL).mean(axis=1)>FRAC).mean()
fs=np.linspace(0,.6,49)
fig,ax=plt.subplots(figsize=(8,4.6))
for d,c in zip((22,25,30,45),("#d62728","#ff7f0e","#2ca02c","#1f77b4")):
    ax.plot(fs*50,[pf(f,d) for f in fs],marker='o',ms=3,color=c,label=f"giro real de {d}°")
ax.axvline(FRAC*50,color='k',ls='--',lw=1.2)
ax.text(FRAC*50+.6,.5,"umbral de R1\n(30 % = 15 s)",fontsize=9)
ax.set_xlabel("Segundos de la ventana de 50 s con la cabeza girada")
ax.set_ylabel("P(R1 dispara)")
ax.set_title("Curva operativa de R1 a nivel ventana\nerror de yaw Laplace(b=3,21°), ajustado a lo medido en AFLW2000-3D",fontsize=11)
ax.grid(alpha=.25); ax.legend(fontsize=9); ax.set_ylim(-.03,1.03)
fig.tight_layout(); fig.savefig("curva_operativa_R1.png",dpi=160); print("ok")
