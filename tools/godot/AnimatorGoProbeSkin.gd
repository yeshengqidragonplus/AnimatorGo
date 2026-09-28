extends SceneTree
## AnimatorGo 的 Godot 蒙皮探针:渲染到 SubViewport 读像素,核对 Polygon2D 蒙皮的真实行为。
## 要渲染,**不能加 --headless**:
##   godot --path <工程> --script res://AnimatorGoProbeSkin.gd
##
## 每个用例画一个 8×8 的白色小方块,量它在图上的质心,与按假设算出的位置比。
## Godot 2D 的 Y 朝下,rotation 为正时在屏幕上是顺时针。

const SIZE := 400

var results: PackedStringArray = []
var cases: Array[Dictionary] = []
var frames := 0

func check(label: String, ok: bool, detail: String) -> void:
	results.append(("✅ " if ok else "❌ ") + label + ":" + detail)

func white(w: int, h: int) -> ImageTexture:
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	img.fill(Color.WHITE)
	return ImageTexture.create_from_image(img)

## 以 center 为中心的 8×8 方块(4 个顶点,全部 100% 挂到一根骨骼)
func square(center: Vector2) -> PackedVector2Array:
	return PackedVector2Array([center + Vector2(-4, -4), center + Vector2(4, -4), center + Vector2(4, 4), center + Vector2(-4, 4)])

func make_case(label: String, expected: Vector2) -> Dictionary:
	var vp := SubViewport.new()
	vp.size = Vector2i(SIZE, SIZE)
	vp.transparent_bg = true
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	get_root().add_child(vp)
	var scene := Node2D.new()
	vp.add_child(scene)
	var skel := Skeleton2D.new()
	scene.add_child(skel)
	var c := {"label": label, "expected": expected, "vp": vp, "scene": scene, "skel": skel}
	cases.append(c)
	return c

func bone(parent: Node, bone_name: String, rest: Transform2D) -> Bone2D:
	var b := Bone2D.new()
	b.name = bone_name
	b.set_autocalculate_length_and_angle(false)
	b.set_length(10)
	parent.add_child(b)
	b.rest = rest
	b.transform = rest
	return b

func skinned(c: Dictionary, polygon: PackedVector2Array, bone_path: String) -> Polygon2D:
	var poly := Polygon2D.new()
	c["scene"].add_child(poly)
	poly.texture = white(8, 8)
	poly.polygon = polygon
	poly.uv = PackedVector2Array([Vector2(0, 0), Vector2(8, 0), Vector2(8, 8), Vector2(0, 8)])
	poly.polygons = [PackedInt32Array([0, 1, 2]), PackedInt32Array([0, 2, 3])]
	poly.skeleton = poly.get_path_to(c["skel"])
	poly.add_bone(NodePath(bone_path), PackedFloat32Array([1, 1, 1, 1]))
	return poly

func _initialize() -> void:
	# 1. 蒙皮公式:v' = B_pose · B_rest⁻¹ · v(骨架空间,Skeleton2D 与 Polygon2D 都是单位变换)
	#    骨骼 rest 在 (100,200),方块在 (184,200);骨骼转 +90° 后应到 (100,284)
	var c1 := make_case("蒙皮 = B_pose · B_rest⁻¹ · v", Vector2(100, 284))
	var a1 := bone(c1["skel"], "a", Transform2D(0.0, Vector2(100, 200)))
	skinned(c1, square(Vector2(184, 200)), "a")
	a1.rotation = PI / 2

	# 2. 辅助子骨骼:局部变换恒为单位、rest = B_rest⁻¹ · Bind。网格按「在 Bind 姿势下绑定」给顶点:
	#    Bind = 骨骼在 (100,150) 时,顶点局部 (84,0) → 绑定时世界 (184,150)。
	#    Spine 的期望:B_pose · (84,0)。骨骼 rest (100,200) 转 +90° → (100,284)
	var c2 := make_case("辅助子骨骼表达「每个网格自己的绑定姿势」", Vector2(100, 284))
	var a2 := bone(c2["skel"], "a", Transform2D(0.0, Vector2(100, 200)))
	var bind := Transform2D(0.0, Vector2(100, 150))
	var helper := bone(a2, "a_bind_mesh", Transform2D())
	helper.rest = a2.rest.affine_inverse() * bind
	helper.transform = Transform2D()
	skinned(c2, square(Vector2(184, 150)), "a/a_bind_mesh")
	a2.rotation = PI / 2

	# 3. deform 与蒙皮的先后:rest 空间的顶点整体 +(20,0),骨骼转 +90°。
	#    先加再蒙皮 → (100,304);先蒙皮再加 → (120,284)
	var c3 := make_case("deform 是「加完再蒙皮」", Vector2(100, 304))
	var a3 := bone(c3["skel"], "a", Transform2D(0.0, Vector2(100, 200)))
	skinned(c3, square(Vector2(204, 200)), "a")
	a3.rotation = PI / 2

	# 4. 骨骼缩放 + 非等比:rest 缩放 1,姿势 scale (2, 1) 再转 0 → (100 + 84*2, 200) = (268, 200)
	var c4 := make_case("骨骼缩放参与蒙皮", Vector2(268, 200))
	var a4 := bone(c4["skel"], "a", Transform2D(0.0, Vector2(100, 200)))
	skinned(c4, square(Vector2(184, 200)), "a")
	a4.scale = Vector2(2, 1)

func centroid(img: Image) -> Vector2:
	var sum := Vector2.ZERO
	var n := 0
	for y in img.get_height():
		for x in img.get_width():
			if img.get_pixel(x, y).a > 0.5:
				sum += Vector2(x + 0.5, y + 0.5)
				n += 1
	return sum / n if n > 0 else Vector2(-1, -1)

func discrete_modes() -> void:
	# 离散轨道往回拖时不重新求值(第一个探针的 ❌)。看 callback_mode_discrete 各档位
	for mode in [AnimationMixer.ANIMATION_CALLBACK_MODE_DISCRETE_DOMINANT, AnimationMixer.ANIMATION_CALLBACK_MODE_DISCRETE_RECESSIVE, AnimationMixer.ANIMATION_CALLBACK_MODE_DISCRETE_FORCE_CONTINUOUS]:
		var host := Node2D.new()
		get_root().add_child(host)
		var target := Node2D.new()
		target.name = "t"
		host.add_child(target)
		var anim := Animation.new()
		anim.length = 1.0
		var tv := anim.add_track(Animation.TYPE_VALUE)
		anim.track_set_path(tv, NodePath("t:visible"))
		anim.value_track_set_update_mode(tv, Animation.UPDATE_DISCRETE)
		anim.track_insert_key(tv, 0.0, true)
		anim.track_insert_key(tv, 0.5, false)
		var tz := anim.add_track(Animation.TYPE_VALUE)
		anim.track_set_path(tz, NodePath("t:z_index"))
		anim.value_track_set_update_mode(tz, Animation.UPDATE_DISCRETE)
		anim.track_insert_key(tz, 0.0, 0)
		anim.track_insert_key(tz, 0.5, 5)
		var lib := AnimationLibrary.new()
		lib.add_animation("a", anim)
		var p := AnimationPlayer.new()
		host.add_child(p)
		p.add_animation_library("", lib)
		p.callback_mode_discrete = mode
		p.play("a")
		var seq := []
		for t in [0.5, 0.25, 0.75, 0.1, 0.49, 0.51]:
			p.seek(t, true)
			seq.append("%s@%.2f=%s/%d" % ["" , t, "亮" if target.visible else "灭", target.z_index])
		var ok: bool = (seq == ["@0.50=灭/5", "@0.25=亮/0", "@0.75=灭/5", "@0.10=亮/0", "@0.49=亮/0", "@0.51=灭/5"])
		check("callback_mode_discrete=%d 前后乱拖都对" % mode, ok, " ".join(seq))
		host.queue_free()

func _process(_delta: float) -> bool:
	frames += 1
	if frames < 6:
		return false
	for c in cases:
		var img: Image = c["vp"].get_texture().get_image()
		var got := centroid(img)
		var exp: Vector2 = c["expected"]
		check(c["label"], got.distance_to(exp) < 1.0, "质心 %s,期望 %s" % [str(got), str(exp)])
	discrete_modes()
	for line in results:
		print(line)
	return true
