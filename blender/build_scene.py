#!/usr/bin/env python3
"""GrainGuard - 3D scene builder for Blender 5.x (headless).

Run:
  blender --background --factory-startup --python-exit-code 1 --python build_scene.py
Outputs into ./out : grain_guard_3d.blend, preview.png, grain_guard.glb
"""
import bpy, math, os
from mathutils import Vector

R = math.radians
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

# ------------------------------------------------------------------ reset
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
for m in list(bpy.data.materials):
    bpy.data.materials.remove(m)
for c in list(bpy.data.cameras):
    bpy.data.cameras.remove(c)
for l in list(bpy.data.lights):
    bpy.data.lights.remove(l)

# ------------------------------------------------------------------ helpers
def mat(name, color, rough=0.6, metal=0.0, emit=None, emit_str=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Alpha"].default_value = alpha
    if emit is not None:
        if "Emission Color" in b.inputs:
            b.inputs["Emission Color"].default_value = (*emit, 1.0)
        if "Emission Strength" in b.inputs:
            b.inputs["Emission Strength"].default_value = emit_str
    return m

def box(name, dims, loc, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = (dims[0], dims[1], dims[2])
    if m: o.data.materials.append(m)
    return o

def cyl(name, r, depth, loc, m, rot=(0, 0, 0), verts=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth,
                                        location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    if m: o.data.materials.append(m)
    return o

def sph(name, r, loc, m, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=24, ring_count=16)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    if m: o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o

def cone(name, r, depth, loc, m):
    bpy.ops.mesh.primitive_cone_add(radius1=r, depth=depth, location=loc)
    o = bpy.context.active_object
    o.name = name
    if m: o.data.materials.append(m)
    return o

def text(name, body, loc, size, m, extrude=0.02, rot=(R(90), 0, 0)):
    bpy.ops.object.text_add(location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.body = body
    o.data.size = size
    o.data.extrude = extrude
    o.data.align_x = 'CENTER'
    o.data.align_y = 'CENTER'
    if m: o.data.materials.append(m)
    return o

def wire(name, pts, m, r=0.035):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = 3
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    ob = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(ob)
    cu.materials.append(m)
    return ob

# ------------------------------------------------------------------ materials
m_ground = mat("ground", (0.06, 0.065, 0.08), rough=0.95)
m_conc   = mat("concrete", (0.52, 0.52, 0.50), rough=0.85)
m_roof   = mat("roof", (0.30, 0.30, 0.32), rough=0.8)
m_grain  = mat("grain", (0.85, 0.58, 0.16), rough=0.75)
m_wood   = mat("dunnage", (0.28, 0.18, 0.10), rough=0.9)
m_panel  = mat("shutter", (0.68, 0.70, 0.72), rough=0.5, metal=0.4)
m_dark   = mat("dark_plastic", (0.05, 0.05, 0.06), rough=0.6)
m_pcb    = mat("pcb_green", (0.05, 0.35, 0.14), rough=0.5)
m_metal  = mat("metal", (0.75, 0.76, 0.78), rough=0.3, metal=0.9)
m_wire   = mat("wire_rubber", (0.10, 0.10, 0.11), rough=0.8)
m_glass  = mat("glass_slab", (0.35, 0.85, 0.95), rough=0.1, emit=(0.2, 0.7, 0.9),
               emit_str=0.6, alpha=0.35)
m_gate   = mat("gate_off", (0.22, 0.24, 0.28), rough=0.7)
m_fired  = mat("gate_fired", (1.0, 0.45, 0.05), rough=0.4, emit=(1.0, 0.4, 0.02), emit_str=4.0)
m_chip   = mat("state_chip", (1.0, 0.75, 0.1), rough=0.4, emit=(1.0, 0.65, 0.05), emit_str=3.0)
m_lock   = mat("gold_lock", (0.85, 0.62, 0.15), rough=0.25, metal=1.0)
m_fan    = mat("fan_metal", (0.55, 0.58, 0.62), rough=0.35, metal=0.8)
m_bubble = mat("slm_bubble", (0.95, 0.96, 1.0), rough=0.5, emit=(0.9, 0.93, 1.0), emit_str=0.4)
m_led_ok = mat("ledger_ok", (0.15, 0.16, 0.18), rough=0.7)
m_led_bad = mat("ledger_bad", (0.9, 0.1, 0.08), rough=0.5, emit=(1.0, 0.05, 0.02), emit_str=4.0)
m_txt    = mat("txt_light", (0.9, 0.93, 1.0), emit=(0.85, 0.9, 1.0), emit_str=1.6)
m_txt_dim = mat("txt_dim", (0.7, 0.72, 0.78), emit=(0.6, 0.65, 0.75), emit_str=0.8)
m_txt_dark = mat("txt_dark", (0.05, 0.05, 0.08))
m_txt_fire = mat("txt_fire", (1.0, 0.5, 0.05), emit=(1.0, 0.4, 0.02), emit_str=4.0)
m_txt_gold = mat("txt_gold", (1.0, 0.8, 0.2), emit=(1.0, 0.7, 0.1), emit_str=3.0)
m_shaft = mat("roof_light", (1.0, 0.95, 0.7), emit=(1.0, 0.92, 0.6), emit_str=3.0)

m_pkt = {
    "temp": mat("pkt_temp", (1, 0.4, 0.1), emit=(1, 0.35, 0.05), emit_str=6.0),
    "rh":   mat("pkt_rh", (0.1, 0.6, 1), emit=(0.05, 0.5, 1), emit_str=6.0),
    "ldr":  mat("pkt_ldr", (1, 0.85, 0.2), emit=(1, 0.8, 0.1), emit_str=6.0),
    "dist": mat("pkt_dist", (0.7, 0.3, 1), emit=(0.6, 0.2, 1), emit_str=6.0),
    "fork": mat("pkt_fork", (0.1, 1, 0.5), emit=(0.05, 1, 0.4), emit_str=6.0),
}

# poster-style colored label materials (B: sensor labels)
m_lbl_blue   = mat("lbl_blue",   (0.25, 0.65, 1.0), emit=(0.15, 0.55, 1.0), emit_str=2.2)
m_lbl_green  = mat("lbl_green",  (0.2, 0.95, 0.5),  emit=(0.1, 0.9, 0.4),   emit_str=2.2)
m_lbl_orange = mat("lbl_orange", (1.0, 0.6, 0.15),  emit=(1.0, 0.5, 0.08),  emit_str=2.2)
m_lbl_red    = mat("lbl_red",    (1.0, 0.3, 0.3),   emit=(1.0, 0.2, 0.2),   emit_str=2.2)
m_lbl_purple = mat("lbl_purple", (0.7, 0.4, 1.0),   emit=(0.6, 0.3, 1.0),   emit_str=2.2)
m_lbl_teal   = mat("lbl_teal",   (0.15, 0.9, 0.85), emit=(0.1, 0.85, 0.8),  emit_str=2.2)
m_lbl_gray   = mat("lbl_gray",   (0.75, 0.78, 0.85), emit=(0.65, 0.7, 0.8), emit_str=1.6)
m_chip_bg    = mat("chip_bg",    (0.03, 0.04, 0.06), rough=0.5)

# ============================================================ L1 PHYSICAL
bpy.ops.mesh.primitive_plane_add(size=50, location=(0, 0, -0.02))
gnd = bpy.context.active_object
gnd.name = "ground"
gnd.data.materials.append(m_ground)

box("floor", (8.6, 6.6, 0.2), (0, 0, 0.1), m_conc)
box("wall_back", (8.6, 0.2, 3.2), (0, 3.2, 1.7), m_conc)
box("wall_left", (0.2, 6.6, 3.2), (-4.2, 0, 1.7), m_conc)
box("wall_right", (0.2, 6.6, 3.2), (4.2, 0, 1.7), m_conc)
# roof with a gap (the intrusion route)
box("roof_L", (5.3, 6.8, 0.16), (-1.65, 0, 3.4), m_roof)
box("roof_R", (2.7, 6.8, 0.16), (2.95, 0, 3.4), m_roof)
box("roof_gap_marker", (0.6, 6.8, 0.05), (1.3, 0, 3.4), m_fired)

# dunnage + grain bulk
for xi in (-2.6, -0.9, 0.9, 2.6):
    for yi in (-1.6, 0.2, 2.0):
        box(f"dunnage_{xi}_{yi}", (0.5, 0.5, 0.4), (xi, yi, 0.4), m_wood)
box("grain_bulk", (6.6, 5.0, 1.9), (0, 0.2, 1.55), m_grain)
# light shaft falling through the roof gap onto the grain
box("light_pool", (0.7, 4.9, 0.05), (1.3, 0.2, 2.53), m_shaft)

# shutter + LDR on the right wall (outside face, visible to camera)
box("shutter", (0.12, 1.5, 1.9), (4.32, 0.5, 1.15), m_panel)
for zz in (0.6, 1.15, 1.7):
    box(f"shutter_rib_{zz}", (0.06, 1.5, 0.1), (4.40, 0.5, zz), m_dark)
cyl("ldr", 0.09, 0.14, (4.44, 0.5, 2.45), m_dark, rot=(0, R(90), 0))
sph("ldr_glow", 0.045, (4.52, 0.5, 2.45), m_pkt["ldr"])

# temp+RH probe stuck in the grain
cyl("probe_stem", 0.06, 1.3, (-1.5, 0.5, 2.15), m_metal)
box("probe_head", (0.28, 0.28, 0.22), (-1.5, 0.5, 2.92), m_dark)

# ultrasonic sensor under the roof, aiming down
box("usonic_body", (0.6, 0.3, 0.15), (0.5, -1.0, 3.25), m_pcb)
cyl("usonic_a", 0.09, 0.12, (0.35, -1.0, 3.13), m_metal)
cyl("usonic_b", 0.09, 0.12, (0.65, -1.0, 3.13), m_metal)

# fork sensor plate in the dunnage gap
box("fork_plate", (0.9, 0.6, 0.05), (-0.5, -1.9, 0.52), m_pcb)

# Arduino UNO board, front-left, tilted toward camera
board = box("uno_board", (1.5, 1.0, 0.12), (-3.4, -3.9, 1.15), m_pcb,
            rot=(R(65), 0, R(-15)))
box("uno_chip", (0.5, 0.5, 0.08), (-3.4, -3.86, 1.21), m_dark, rot=(R(65), 0, R(-15)))
box("uno_usb", (0.35, 0.3, 0.22), (-3.85, -3.78, 1.30), m_metal, rot=(R(65), 0, R(-15)))
box("uno_pins", (1.1, 0.12, 0.10), (-3.3, -4.06, 1.05), m_dark, rot=(R(65), 0, R(-15)))
sph("uno_led", 0.05, (-3.05, -3.95, 1.28), m_pkt["fork"])

# wires from the UNO to every sensor
wire("w_probe", [(-3.4, -3.7, 1.3), (-3.0, -2.0, 2.6), (-2.0, -0.2, 3.0), (-1.5, 0.5, 2.65)], m_wire)
wire("w_usonic", [(-3.3, -3.7, 1.35), (-2.0, -2.8, 3.3), (0.5, -1.6, 3.4), (0.5, -1.0, 3.30)], m_wire)
wire("w_ldr", [(-3.2, -3.8, 1.3), (-1.0, -3.6, 3.5), (3.0, -3.0, 3.5), (4.1, -0.5, 3.2), (4.36, 0.5, 2.5)], m_wire)
wire("w_fork", [(-3.5, -3.9, 1.0), (-2.8, -3.4, 0.5), (-1.4, -2.6, 0.45), (-0.5, -1.9, 0.52)], m_wire)

# ---------------- extra hardware from the poster (B) ----------------
# DHT11 module on the back wall (temp & RH)
box("dht11_body", (0.5, 0.12, 0.7), (2.8, 3.05, 2.95), m_pcb)
box("dht11_grid", (0.3, 0.06, 0.3), (2.8, 2.97, 3.0), m_dark)
sph("dht11_led", 0.04, (2.8, 2.96, 2.62), m_pkt["rh"])
wire("w_dht", [(-3.3, -3.7, 1.35), (-1.0, -3.9, 3.6), (2.2, -1.5, 3.6), (2.8, 2.7, 3.1)], m_wire)

# Grain-moisture FC-28 probe poking out the front face of the grain bulk
box("fc28_body", (0.5, 0.35, 0.06), (0.3, -2.42, 1.4), m_pcb, rot=(R(-90), 0, 0))
cyl("fc28_prong1", 0.03, 0.3, (0.2, -2.6, 1.4), m_metal, rot=(R(90), 0, 0))
cyl("fc28_prong2", 0.03, 0.3, (0.4, -2.6, 1.4), m_metal, rot=(R(90), 0, 0))
wire("w_fc28", [(-3.4, -3.8, 1.2), (-1.5, -3.2, 1.5), (0.3, -2.6, 1.45)], m_wire)

# Battery pack + Bluetooth module next to the controller
box("battery", (0.9, 0.55, 0.35), (-3.4, -2.9, 1.15), m_dark, rot=(R(65), 0, R(-15)))
box("battery_label", (0.7, 0.05, 0.2), (-3.4, -2.96, 1.24), m_lbl_green, rot=(R(65), 0, R(-15)))
box("bt_module", (0.55, 0.4, 0.08), (-4.6, -3.7, 1.15), m_pcb, rot=(R(65), 0, R(-15)))
sph("bt_led", 0.04, (-4.6, -3.78, 1.28), m_lbl_blue)
wire("w_bt", [(-4.0, -3.8, 1.25), (-4.3, -3.75, 1.2)], m_wire)

# ---- poster-style sensor callout labels + leader lines ----
def callout(name, body, anchor, label, m, size=0.26):
    """anchor = sensor position; label = where the text floats."""
    text(name, body, label, size, m, rot=(R(90), 0, 0))
    wire(name + "_lead", [anchor, ((anchor[0] + label[0]) / 2,
                                    min(anchor[1], label[1]) - 0.4,
                                    (anchor[2] + label[2]) / 2 + 0.2),
                          (label[0], label[1] + 0.15, label[2] - size * 0.7)],
         m, r=0.018)

# labels sit in front of the shed (y < -3.6) so the camera sees them
callout("lbl_usonic", "HC-SR04  Ultrasonic", (0.5, -1.0, 3.25),
        (1.9, -4.6, 4.15), m_lbl_purple)
callout("lbl_dht11", "DHT11  Temp & RH", (2.8, 3.0, 3.0),
        (5.9, -3.4, 3.9), m_lbl_blue)
callout("lbl_ldr", "LDR  Light / Shutter", (4.5, 0.5, 2.45),
        (6.3, -3.4, 2.7), m_lbl_orange)
callout("lbl_probe", "Grain Temp  DS18B20", (-1.5, 0.5, 2.9),
        (-4.3, -4.6, 3.5), m_lbl_red)
callout("lbl_fc28", "Grain Moisture  FC-28", (0.3, -2.5, 1.4),
        (2.4, -4.9, 1.5), m_lbl_green)
callout("lbl_forkp", "Fork Probe  Dunnage", (-0.5, -1.9, 0.52),
        (-2.9, -4.9, 0.85), m_lbl_teal)
callout("lbl_ctrl", "Arduino / ESP32  +  Battery 11.1V", (-3.4, -3.9, 1.15),
        (-4.9, -5.4, 2.25), m_lbl_gray, size=0.24)
callout("lbl_bt", "Bluetooth  Local Sync", (-4.6, -3.7, 1.15),
        (-6.9, -4.6, 1.35), m_lbl_blue, size=0.22)

# ============================================================ L2 EVIDENCE
# glowing packets rising from each sensor toward the physics slab
pkt_x = {"temp": -1.5, "rh": -1.15, "dist": 0.5, "ldr": 4.3, "fork": -0.5}
pkt_y = {"temp": 0.5, "rh": 0.8, "dist": -1.0, "ldr": 0.5, "fork": -1.9}
z0 = {"temp": 3.2, "rh": 3.2, "dist": 3.4, "ldr": 2.7, "fork": 0.7}
for k in pkt_x:
    for i in range(3):
        z = z0[k] + 0.55 + i * 0.55
        # packets converge toward x=0 as they climb
        x = pkt_x[k] * (1.0 - 0.18 * (i + 1))
        y = pkt_y[k] * (1.0 - 0.15 * (i + 1))
        s = sph(f"pkt_{k}_{i}", 0.11, (x, y, z), m_pkt[k])
        s.scale = (1, 1, 1)

# thin evidence trails (vertical dotted lines)
for k in pkt_x:
    for i in range(3):
        z = z0[k] + 0.30 + i * 0.55
        x = pkt_x[k] * (1.0 - 0.18 * (i + 1))
        y = pkt_y[k] * (1.0 - 0.15 * (i + 1))
        cyl(f"trail_{k}_{i}", 0.02, 0.28, (x, y, z), m_wire)

# ============================================================ L3 PHYSICS
slab = box("physics_slab", (7.0, 4.5, 0.55), (0, 0, 5.6), m_glass)
text("lbl_physics", "PHYSICS  ·  EMC  ·  DEW  ·  dH", (0, -2.3, 6.15), 0.42,
     m_txt, rot=(R(90), 0, 0))
# poster-style live metric chips across the slab face
metrics = [("-2.55", "26.4°C"), ("-0.85", "58.2% RH"),
           ("0.85", "12.8% moisture"), ("2.55", "420 ppm CO2")]
for xs, body in metrics:
    x = float(xs)
    box(f"chip_{xs}", (1.5, 0.12, 0.5), (x, -2.28, 5.6), m_chip_bg)
    text(f"chip_txt_{xs}", body, (x, -2.36, 5.6), 0.24, m_txt,
         rot=(R(90), 0, 0))
# raw in / derived out markers
text("raw_in", "raw in", (-3.6, -2.3, 6.15), 0.3, m_txt_dim)
text("derived_out", "derived out", (3.4, -2.3, 6.15), 0.3, m_txt_dim)

# ============================================================ L4 DECISION
# 7 ordered rule gates; gate index 4 (RH>65%) is the one that fires for S1
gate_states = ["S5", "S2", "S4", "S4", "S1", "S3", "S0"]
fired_idx = 4
for i, gs in enumerate(gate_states):
    x = -3.6 + i * 1.2
    fired = (i == fired_idx)
    box(f"gate_{i}", (0.9, 0.16, 1.15), (x, 0, 7.0),
        m_fired if fired else m_gate)
    # evaluation arrow above each gate
    cone(f"gatearr_{i}", 0.16, 0.3, (x, 0, 7.75),
         m_txt_fire if fired else m_txt_dim)
    text(f"gtxt_{i}", gs, (x, -0.09, 7.0), 0.34,
         m_txt_fire if fired else m_txt, rot=(R(90), 0, 0))
text("lbl_rules", "ORDERED RULE ENGINE", (0, 0, 6.35), 0.36, m_txt_dim,
     rot=(R(90), 0, 0))
text("lbl_fired", "rule 5 fired: RH > 65%", (0, 0, 8.15), 0.34, m_txt_fire,
     rot=(R(90), 0, 0))

# state + risk chip
box("state_chip", (3.4, 0.5, 0.75), (0, 0, 8.85), m_chip)
text("state_txt", "S1 ATMO_INGRESS · HIGH", (0, -0.27, 8.85), 0.34,
     m_txt_dark, rot=(R(90), 0, 0))

# ============================================================ L5 HUMAN + SLM
# aeration fan (left) with a physical padlock
cyl("fan_hub", 0.28, 0.5, (-4.6, 0, 10.2), m_fan, rot=(0, R(90), 0))
for a in range(6):
    ang = a * 60
    box(f"fan_blade_{a}", (0.18, 1.7, 0.06),
        (-4.6, 0.85 * math.cos(R(ang)), 10.2 + 0.85 * math.sin(R(ang))),
        m_fan, rot=(R(ang), 0, 0))
cyl("fan_ring", 1.15, 0.12, (-4.6, 0, 10.2), m_dark, rot=(0, R(90), 0))
# padlock over the fan
box("lock_body", (0.7, 0.3, 0.55), (-4.6, -0.5, 10.0), m_lock)
bpy.ops.mesh.primitive_torus_add(location=(-4.6, -0.5, 10.42),
                                 rotation=(R(90), 0, 0),
                                 major_radius=0.26, minor_radius=0.06)
tor = bpy.context.active_object
tor.name = "lock_shackle"
tor.data.materials.append(m_lock)
text("lbl_lock", "FAN LOCKED · human unlock", (-4.6, -0.9, 9.3), 0.3,
     m_txt_gold, rot=(R(90), 0, 0))

# SLM speech bubble (dotted line to the state chip = rewords only)
sph("slm_bubble", 0.85, (4.4, 0, 10.3), m_bubble, scale=(1.25, 0.7, 0.95))
text("slm_txt", "SLM:\nexplains\nonly", (4.4, -0.62, 10.3), 0.3, m_txt_dark,
     rot=(R(90), 0, 0))
for i in range(5):  # dotted connector state_chip -> bubble
    sph(f"slm_dot_{i}", 0.06, (1.9 + i * 0.45, 0, 9.55 + i * 0.14), m_txt_dim)
text("lbl_slm_never", "never decides", (4.4, -0.62, 9.35), 0.26, m_txt_dim,
     rot=(R(90), 0, 0))

# tamper-evident ledger chain (one bad block escalated)
for i in range(5):
    bad = (i == 3)
    box(f"ledger_{i}", (0.62, 0.3, 0.5), (-1.6 + i * 0.78, -1.9, 10.0),
        m_led_bad if bad else m_led_ok)
    if i > 0:  # chain link
        cyl(f"chain_{i}", 0.06, 0.28, (-1.6 + i * 0.78 - 0.39, -1.9, 10.0),
            m_lock, rot=(0, R(90), 0))
text("lbl_ledger", "hash-chained ledger · unverified ack escalated",
     (0, -1.9, 9.5), 0.28, m_txt_dim, rot=(R(90), 0, 0))

# decision arrow: engine below -> human on top
for i in range(4):
    cone(f"uparrow_{i}", 0.14, 0.3, (0, 1.6, 9.35 + i * 0.34), m_txt_dim)

# layer labels (left rail)
layers = [("1  PHYSICAL", 0.7), ("2  EVIDENCE", 4.4), ("3  PHYSICS", 6.4),
          ("4  DECISION", 9.6), ("5  HUMAN + SLM", 12.4)]
for name, z in layers:
    text("rail_" + name[:1], name, (-6.4, 0, z), 0.4, m_txt, rot=(R(90), 0, R(90)))

# title
text("title", "GRAIN-GUARD", (0, 3.5, 11.9), 0.8, m_txt_gold, rot=(R(90), 0, 0))
text("subtitle", "Smart Grain Storage Monitoring System", (0, 3.5, 11.15), 0.32,
     m_txt, rot=(R(90), 0, 0))
text("tagline", "Because every grain counts.", (0, -3.45, 0.55), 0.3,
     m_txt_dim, rot=(R(90), 0, 0))

# ============================================================ LIGHTS + CAMERA
bpy.ops.object.light_add(type='SUN', location=(6, -8, 14))
sun = bpy.context.active_object
sun.data.energy = 3.5
sun.rotation_euler = (R(45), R(12), R(35))

bpy.ops.object.light_add(type='AREA', location=(-7, -10, 9))
fill = bpy.context.active_object
fill.data.energy = 900
fill.data.size = 7
fill.rotation_euler = (R(55), 0, R(-35))

bpy.ops.object.light_add(type='POINT', location=(0, -3, 7.5))
pt = bpy.context.active_object
pt.data.energy = 350

bpy.ops.object.camera_add(location=(11.5, -14.5, 8.5))
cam = bpy.context.active_object
cam.data.lens = 32
target = Vector((0, 0, 5.9))
d = target - cam.location
cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam

world = bpy.data.worlds.new("World") if not bpy.data.worlds else bpy.data.worlds[0]
bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.015, 0.02, 0.035, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.6

# ============================================================ RENDER + SAVE
sc = bpy.context.scene
try:
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
except Exception:
    pass
sc.render.resolution_x = 1600
sc.render.resolution_y = 1000
sc.render.film_transparent = False

blend_path = os.path.join(OUT, "grain_guard_3d.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend_path)
print("SAVED_BLEND", blend_path)

sc.render.filepath = os.path.join(OUT, "preview.png")
bpy.ops.render.render(write_still=True)
print("SAVED_RENDER", sc.render.filepath)

try:
    glb = os.path.join(OUT, "grain_guard.glb")
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB')
    print("SAVED_GLB", glb)
except Exception as e:
    print("GLB_EXPORT_SKIPPED", e)

print("BUILD_DONE")

