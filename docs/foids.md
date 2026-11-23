# Foids: navigation, muscles, body and water

Foids is the fish system in `salmon-farm`. Schooling chooses swimming effort and route curvature. Those requests activate muscles and fins. A free articulated body then responds to internal torque, inertia, fluid forces and contact. The rendered centerline and fin poses are the outputs of that calculation.

This is a documented, reduced planar mechanical model for an interactive scene. Its coefficients are engineering choices, not measurements fitted to a particular species. It is not a new biological discovery, a validated digital twin, a complete fluid solver, or a claim of unprecedented scientific accuracy.

## Primary research

| Source | Consequence for this implementation |
| --- | --- |
| [Tytell et al., 2010, Interactions between internal forces, body stiffness, and fluid environment in a neuromechanical model of lamprey swimming](https://pmc.ncbi.nlm.nih.gov/articles/PMC2993357/) | Muscle activation does not uniquely prescribe a bend: elasticity, inertia and water load determine the resulting motion. Use muscle torque and passive joint mechanics, rather than imposing animated poses and then assigning a swimming speed. Their immersed-boundary Navier–Stokes model is substantially more complete than this scene's local fluid approximation. |
| [Li et al., 2021, Effects of Design and Hydrodynamic Parameters on Optimized Swimming for Simulated, Fish-inspired Robots](https://arxiv.org/abs/2111.05682) | Distinguish mechanical body dynamics, added water mass, pressure effects and resistive forces. Added mass by itself is not an adequate caudal propulsion model. Their experiments concern a robotic template; its coefficients are not imported as biological measurements. |
| [Piñeirua, Godoy-Diana and Thiria, 2015, Resistive thrust production can be as crucial as added mass mechanisms for inertial undulatory swimmers](https://arxiv.org/abs/1507.04952) | Include distributed cross-flow resistance as well as fluid inertia. A normal force on an angled moving surface has both lateral and axial components; those components produce the motion directly. |
| [Howe and Astley, 2020, The control of routine fish maneuvers](https://onlinelibrary.wiley.com/doi/10.1002/jez.2398) | Maneuver outcomes depend on the timing and distribution of curvature along the fish. Use a traveling activation wave and a coherent articulated body. The previous independent skull gesture and overlapping curvature-pulse animation have been removed. |
| [Drucker and Lauder, 2001, Wake dynamics and fluid forces of turning maneuvers in sunfish](https://pubmed.ncbi.nlm.nih.gov/11171296/) | Asymmetric paired-fin forces can contribute to yaw at low swimming speeds. Model small rowing surfaces at their actual roots, with a feathered recovery stroke; do not use a standalone yaw actuator. Fin behavior is species-dependent. |
| [MuJoCo's authored fluid-force derivation](https://mujoco.readthedocs.io/en/stable/computation/fluid.html) | Provides a documented reference for stateless added mass, resistance and quasi-steady Kutta lift. The caudal membrane uses a finite-span, angle-dependent lift approximation, integrated with the same generalized coordinates as the rest of the body. No MuJoCo dependency is used. |

The navigation layer retains insights from [Katz et al., 2011](https://pmc.ncbi.nlm.nih.gov/articles/PMC3219116/), [Herbert-Read et al., 2011](https://pmc.ncbi.nlm.nih.gov/articles/PMC3219133/), [Calovi et al., 2018](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1005933), and [Tunstrøm et al., 2013](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1002915): position-dependent speed responses, selective social attention, burst/coast timing, wall anticipation, and distinct measures of milling and polarization.

## Mechanical coordinates and units

The mesh extends from `x = 0.49` at the snout to `x = -0.72` at the caudal fork. Actual body length is `L = 1.21 * scale`. Twelve rigid centerline links of length `L / 12` are connected by rotational joints. The first joint has high stiffness, approximating a rigid skull over the anterior sixth of the fish; the next joints can articulate the neck and torso. Skin interpolation smooths the rendered surface between these physical links.

Fourteen generalized coordinates describe a fish:

```
q = [COM.x / L, COM.z / L, theta_0, ..., theta_11]
```

The absolute link angles are mechanical state, not animation controls. Every vertex of the centerline follows by summing fixed-length links. Tissue mass is proportional to cross-sectional volume, using the same tapered body profile as the mesh. The thin caudal membrane has little tissue mass and a substantial projected fluid area.

Dynamics use unit total tissue mass and body lengths. Velocity has units `L/s`, force `m L/s²`, torque `m L²/s²`, and inertia `m L²`. The world conversion is applied to COM position and velocity at the boundary of the solver. Consequently, different fish sizes have geometrically scaled mass/area/inertia relationships rather than sharing a prescribed world-space turning radius.

Let `w_k` be normalized tissue masses, `t_j = [cos(theta_j), sin(theta_j)]`, `n_j = [-sin(theta_j), cos(theta_j)]`, and `ell = 1/12`. Define

```
c_j = sum(w_k for k > j) + w_j/2
a_kj(u) = ell * (c_j - indicator(j < k) - u * indicator(j == k))
r_k(u) = COM + sum_j a_kj(u) * t_j
J_k,j = a_kj(u) * n_j
```

Here `u` runs from the anterior to posterior end of link `k`. The translation columns of `J` are the identity. These coordinates keep the tissue COM independent of shape and preserve all link lengths without position projection. The centrifugal acceleration of a material point is `b = -sum_j a_kj t_j omega_j²`.

## Body and fluid inertia

Each link has tissue inertia and a local added-mass tensor

```
B_k = (w_k + m_added,t) t_k t_k^T
    + (w_k + m_added,n) n_k n_k^T
M(q) = sum_k J_k^T B_k J_k + rotational inertia
```

The normal added mass uses a cross-flow strip estimate proportional to `pi * height² * ell`; longitudinal added mass is much smaller. The rotational term includes both the link's tissue inertia and the integrated normal added mass.

The inertial bias includes centrifugal acceleration, rotation of the anisotropic tensor, and the orientation derivative of its kinetic energy. Merely increasing segment mass would omit those terms. In the implementation:

```
C += J^T (B b + Bdot v)
C_angle -= (B_t - B_n) * v_t * v_n
```

The equation of motion is

```
M(q) qddot + C(q, qdot)
    = Q_muscle + Q_resistance + Q_caudal_lift + Q_fins + Q_net
```

There is no separate assignment of forward speed, commanded whole-body rotation, tail-work thrust proxy, or nonholonomic constraint that forces COM motion to stay exactly parallel to the torso. Small lateral motion is a physical consequence of changing momentum in water. The controller limits excessive slip through muscle feedback instead of removing that velocity after integration.

## Muscles and maneuver control

At each joint, one traveling neural activation changes antagonistic muscle rest curvature. A single recruitment value varies the activation envelope: low demand concentrates motion posteriorly; acceleration and changes in steering load recruit the anterior body. A held circular route does not keep that power recruitment high. Relative targets are differences between adjacent samples of this one activation field, never additions to the rendered pose.

Steering activation travels down a serial motor field with a 12 ms time constant per cell. Its exponential update is evaluated analytically, avoiding propagation speed that changes with the numerical timestep. The source and fast recruitment attack allow anterior torque to respond quickly; posterior muscles receive the changing turning signal later. The skull has no independent target angle or gesture animation.

The caudal membrane has stronger passive support than the narrow peduncle, and its distal rest orientation follows the peduncle's stroke. This transmits a short tail stroke through a supported foil rather than leaving the tip to flap freely. The same body can execute economical tail kicks and a more distributed power stroke without switching animation clips or adding a second body wave.

```
phi_k = theta_k - theta_(k-1)
tau_k = K_k * (phi_rest,k - phi_k) - D_k * phidot_k
```

The solver applies `-tau_k` and `+tau_k` to the adjacent links. Those internal torques cannot accelerate the tissue COM in a vacuum. During powered swimming, stiffness scales with cadence squared and material damping with cadence, preserving their relation to inertial and hydrodynamic loading as the beat slows. Stiffness/damping also scale with spatial discretization, so adding links does not silently soften the whole fish. With motors inactive, passive tissue properties have a constant baseline, independent of the inactive oscillator clock. Compliant angular limits resist excessive bending; joint and whole-body angles are not clamped. Joint work and stored elastic energy are available as diagnostics; active changes in coactivation are muscular input, not a closed-system energy-conservation claim.

Navigation asks for a route curvature. Requested turn rate is that curvature multiplied by **measured positive forward velocity**, with no artificial minimum yaw speed. A feedback controller observes actual course rotation and body/velocity misalignment. Its observer bandwidth scales with cadence so it does not chase individual tail beats. Near rest, where flow direction is ill-conditioned, course feedback is suppressed and its integral releases; measured course rotation becomes reliable as forward travel is established. Speed regulation compares requested speed with signed forward progress, so backward motion cannot masquerade as successful cruising. A geometric feedforward term relates turn rate to forward pace in body lengths; feedback corrects the resulting course. Its output changes muscle asymmetry and modest fin activity; it does not rotate the fish. The body can lead a maneuver, but a stalled fish does not receive the same angular demand as a traveling one.

There is no independent skull lead, head-pulse timer, or overlapping bend overlay. Opposing curvature is still possible in an ordinary traveling swimming wave; it emerges from one connected mechanical body instead of separately animated head and tail instructions.

## Hydrodynamic forces

Two Gauss points per link integrate the local pressure resistance. Each point's velocity includes COM translation and the contributions of all joints:

```
v_point = J qdot
F_drag = -c_t (abs(v_t) + epsilon) v_t t
         -c_n (abs(v_n) + epsilon) v_n n
Q_drag = J^T F_drag
```

Coefficients use the link's projected area, wetted perimeter and normalized tissue volume. The anterior pressure drag is paid once, avoiding fictitious drag on every cut face of the articulated model. Drag is dissipative: `F_drag dot v <= 0`. The small linear term regularizes the near-rest response.

The sharp caudal region also receives finite-span quasi-steady lift. With a coefficient based on membrane area and aspect ratio, the implementation has the form

```
gamma = C * v_t * v_n / sqrt(v dot v + epsilon²)
F_lift = gamma * [v.z, -v.x]
```

This lift is perpendicular to the point's velocity. It redirects fluid reaction rather than adding a prescribed forward thrust, and its point Jacobian supplies the corresponding yaw moment. Circulation is represented algebraically; the model does not explicitly shed or advect a wake.

The two pectoral fins are thin, massless rowing plates attached to the actual anterior link. Sweep and feather angles determine both their surface velocity and the rendered triangles. Root translation, root rotation, sweep and feather rates all contribute to fluid velocity. Feathered recovery presents less projected area. The fin triangle's actual centroid, area and lateral root offset determine force and moment arm.

Pectoral activity is deliberately small: straight swimming uses very small sweep angles, and feathering is scaled by actual stroke amplitude; steering and braking can recruit more. Their motor cadence is lower than the tail cadence. Forward propulsion is predominantly caudal; an ablation test compares the complete swimmer, disabled pectoral motors, and disabled axial motors. Fin inertia is neglected, and hydrodynamic reaction is transmitted to the root.

## Integration and contact

The mechanical base step is 1/120 second, inside the school's fixed 1/60-second sensing step. Each base step solves a nonlinear midpoint update for velocity and configuration. Joint elasticity/damping, the analytic derivative of quadratic resistance, and caudal circulation enter the coupled linear solve. Circulation contributes a skew-symmetric operator; the system is solved with a small dense LU elimination rather than assuming symmetry.

The previous accepted acceleration predicts an initial velocity. A modified Newton solve then evaluates the complete nonlinear force residual up to seven times, reusing a factored Jacobian and rebuilding it when convergence is slow. This avoids repeatedly assembling the dense system for every residual evaluation. The predictor and Jacobian reuse never bypass convergence checks. A solve whose normalized velocity residual exceeds `0.001` is rejected, its state restored, and the interval integrated as two shorter steps. This is numerical error control, not a correction to the fish's motion. Normal convergence terminates earlier. Accepted residuals and accepted substep counts remain available for diagnostics. An unresolved solve at the minimum step raises an error rather than silently replacing the state.

Nets exert unilateral, compliant normal forces at both ends of each thick link. A differentiable transition represents the net's small effective contact thickness. Contact uses the same point Jacobians and midpoint solve as fluid forces. It does not translate a fish back into its pen, clamp velocity axes, rotate violating links to convenient angles, or change link length. A conservative geometric broad phase avoids calculating contacts for fish that cannot reach a wall.

## Schooling and scene

Six compact pens contain 320 fish: `[144, 48, 56, 32, 16, 24]`. Openings are 4.9 × 6.5 scene units. Model scales remain 0.44–0.80, with preferred speeds of 0.26–0.76 scene units/s. A nominal 0.16 swimming floor influences effort, not velocity; a physical obstruction can slow a fish further.

Each fish attends to one compatible frontal leader and at most one salient neighbor on either side. Snapshot sensing, predicted closest approach, elongated body space, depth separation, headway, persistent local turning memory, leader trajectories, wall look-ahead, and individual burst/coast cycles guide its decisions. Course prediction uses measured velocity. Independent excursions and persistent turning tendencies preserve variation across the mill's radius. These are behavioral approximations, not a fitted neural model.

Two module workers integrate the main pen and the other five pens. All sensory clocks consume the same seeded random sequence, and a partition-equivalence test verifies that the split produces identical trajectories. The rendering thread receives complete centerline and fin snapshots through recycled transferable buffers. Pause/visibility suspension bounds outstanding work, and disposal terminates both workers. Environments without worker construction use the same synchronous solver.

The mesh receives twelve mechanical centerline endpoints and four executed fin angles. Spine and fin poses are stored in a floating-point texture, one row per fish, and fetched by instance ID in the vertex shader. This leaves room for Three.js inputs instead of filling the browser’s vertex-attribute budget. The texture is updated from the solved pose and disposed with the scene. Body skin and normals share the same centerline frame. Pectoral triangles are attached rigidly to their simulated root; the shader adds no separate swimming wave or fin phase. HDRI, weathered docks, net geometry, murky depth attenuation, planar reflection and the contiguous refraction filter retain their existing scene roles.

## Verification and limits

Nonvisual regression checks cover:

- Internal muscle torques conserving tissue linear momentum in a vacuum, and bounded, convergent angular-momentum error.
- An unpowered stationary fish remaining still, and passive resistance dissipating energy.
- Acceleration from rest and tail-dominant propulsion with pectoral/axial motor ablations.
- Left/right symmetry, physical reversals, forward travel, size/cadence variation and timestep convergence.
- Anterior muscle work, caudal work, elastic energy and quick head response under power recruitment.
- Independence of passive tissue mechanics from an inactive motor clock.
- Fixed link lengths, the tissue COM, and agreement of the physical and GPU centerlines.
- Net contact, actual leader history, seeded reproducibility, sensory decisions, braking, and motor-off coasting.
- Sustained milling, containment, speed variation, straight-torso alignment, supported angles during bent power strokes, time spent in tail cruising, and accepted solver residuals over a full simulated minute.
- Identical partitioned trajectories and complete centerline/fin state transport, plus a nonvisual worker-thread transfer/recycling check.
- Geometry attribute limits, shared fin poses, dock geometry, water optics, typechecking and the production build.

No browser, screenshot or rendered-page verification is implied by these checks.

The horizontal mechanics are coupled; depth remains a slow behavioral control rather than a vertical hydrodynamic solve. The fluid approximation omits shared wakes, long-range pressure interactions, wall-modified flow, turbulence, free-surface fluid/structure coupling, and fully resolved fish/fish physical contacts. Fish respond to each other through behavioral avoidance and depth separation. Added-mass strips, caudal lift coefficients, muscle parameters and fin feathering require experimental calibration before quantitative biological use. Water appearance is an independent optical approximation. These limitations should remain explicit when judging physical accuracy.
