extends SceneTree
## AnimatorGo 的 Godot 探针:用 Godot 自己的 API 搭一个「骨骼 + 蒙皮网格 + 动画」的样例并存成 .tscn,
## 拿到真实的文件格式;顺带把几个决定导出器设计的行为测清楚。不凭文档写导出器 —— 与 tools/unity/AnimatorGoProbe.cs 同理。
##
## 用法(不需要渲染的部分,可以 --headless):
##   godot --headless --path <工程> --script res://AnimatorGoProbe.gd
## 产物:res://probe.tscn、res://probe_lib.tres;结论逐条打印成 ✅ / ❌。

var results: PackedStringArray = []
var scene: Node2D
var skel: Skeleton2D
var b0: Bone2D
var b1: Bone2D
var poly: Polygon2D
var player: AnimationPlayer
var frames := 0

func check(label: String, ok: bool, detail: String) -> void:
	results.append(("✅ " if ok else "❌ ") + label + ":" + detail)

## 三次贝塞尔 (P0..P3) 在横坐标 x 处的纵坐标 —— 用来核对 Godot 贝塞尔轨道控制柄的语义
func bezier_y_at(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, x: float) -> float:
	var lo := 0.0
	var hi := 1.0
	for i in 60:
		var s := (lo + hi) / 2.0
		var u := 1.0 - s
		var bx := u * u * u * p0.x + 3.0 * u * u * s * p1.x + 3.0 * u * s * s * p2.x + s * s * s * p3.x
		if bx < x:
			lo = s
		else:
			hi = s
	var s2 := (lo + hi) / 2.0
	var u2 := 1.0 - s2
	return u2 * u2 * u2 * p0.y + 3.0 * u2 * u2 * s2 * p1.y + 3.0 * u2 * s2 * s2 * p2.y + s2 * s2 * s2 * p3.y

func _initialize() -> void:
	scene = Node2D.new()
	scene.name = "Probe"

	skel = Skeleton2D.new()
	skel.name = "Skeleton2D"
	scene.add_child(skel)
	skel.owner = scene

	b0 = Bone2D.new()
	b0.name = "b0"
	skel.add_child(b0)
	b0.owner = scene
	b0.rest = Transform2D(0.0, Vector2(10, 20))
	b0.transform = b0.rest

	b1 = Bone2D.new()
	b1.name = "b1"
	b0.add_child(b1)
	b1.owner = scene
	b1.rest = Transform2D(deg_to_rad(30.0), Vector2(50, 0))
	b1.transform = b1.rest

	poly = Polygon2D.new()
	poly.name = "mesh"
	scene.add_child(poly)
	poly.owner = scene
	poly.polygon = PackedVector2Array([Vector2(0, 0), Vector2(100, 0), Vector2(100, 50), Vector2(0, 50)])
	poly.uv = PackedVector2Array([Vector2(0, 0), Vector2(64, 0), Vector2(64, 32), Vector2(0, 32)])
	poly.polygons = [PackedInt32Array([0, 1, 2]), PackedInt32Array([0, 2, 3])]
	poly.skeleton = NodePath("../Skeleton2D")
	poly.add_bone(NodePath("b0"), PackedFloat32Array([1.0, 0.5, 0.0, 0.0]))
	poly.add_bone(NodePath("b0/b1"), PackedFloat32Array([0.0, 0.5, 1.0, 1.0]))
	var img := Image.create(64, 32, false, Image.FORMAT_RGBA8)
	img.fill(Color.RED)
	poly.texture = ImageTexture.create_from_image(img)

	var anim := Animation.new()
	anim.length = 1.0
	anim.loop_mode = Animation.LOOP_LINEAR

	var tr := anim.add_track(Animation.TYPE_VALUE)
	anim.track_set_path(tr, NodePath("Skeleton2D/b0:rotation"))
	anim.track_insert_key(tr, 0.0, 0.0)
	anim.track_insert_key(tr, 1.0, 1.0)

	# deform 要靠它:polygon(顶点数组)能不能在关键帧之间插值
	var tp := anim.add_track(Animation.TYPE_VALUE)
	anim.track_set_path(tp, NodePath("mesh:polygon"))
	anim.track_insert_key(tp, 0.0, poly.polygon)
	anim.track_insert_key(tp, 1.0, PackedVector2Array([Vector2(0, 0), Vector2(200, 0), Vector2(100, 50), Vector2(0, 50)]))

	# 贝塞尔轨道:控制柄是不是「相对关键帧的 (时间, 取值) 偏移」
	var tb := anim.add_track(Animation.TYPE_BEZIER)
	anim.track_set_path(tb, NodePath("Skeleton2D/b0/b1:position:x"))
	anim.bezier_track_insert_key(tb, 0.0, 50.0, Vector2(0, 0), Vector2(0.5, 0))
	anim.bezier_track_insert_key(tb, 1.0, 150.0, Vector2(-0.1, 0), Vector2(0, 0))

	var tv := anim.add_track(Animation.TYPE_VALUE)
	anim.track_set_path(tv, NodePath("mesh:visible"))
	anim.value_track_set_update_mode(tv, Animation.UPDATE_DISCRETE)
	anim.track_insert_key(tv, 0.0, true)
	anim.track_insert_key(tv, 0.5, false)

	var tz := anim.add_track(Animation.TYPE_VALUE)
	anim.track_set_path(tz, NodePath("mesh:z_index"))
	anim.value_track_set_update_mode(tz, Animation.UPDATE_DISCRETE)
	anim.track_insert_key(tz, 0.0, 0)
	anim.track_insert_key(tz, 0.5, 5)

	var tm := anim.add_track(Animation.TYPE_VALUE)
	anim.track_set_path(tm, NodePath("mesh:self_modulate"))
	anim.track_insert_key(tm, 0.0, Color(1, 1, 1, 1))
	anim.track_insert_key(tm, 1.0, Color(1, 0, 0, 0))

	var lib := AnimationLibrary.new()
	lib.add_animation("test", anim)

	player = AnimationPlayer.new()
	player.name = "AnimationPlayer"
	scene.add_child(player)
	player.owner = scene
	player.add_animation_library("", lib)

	get_root().add_child(scene)

	var packed := PackedScene.new()
	var err := packed.pack(scene)
	check("PackedScene.pack", err == OK, str(err))
	check("存 probe.tscn", ResourceSaver.save(packed, "res://probe.tscn") == OK, "res://probe.tscn")
	check("存 probe_lib.tres", ResourceSaver.save(lib, "res://probe_lib.tres") == OK, "res://probe_lib.tres")

func _process(_delta: float) -> bool:
	frames += 1
	if frames < 3:
		return false

	player.play("test")
	player.seek(0.5, true)

	check("rotation 线性插值", is_equal_approx(b0.rotation, 0.5), "t=0.5 时 %f(期望 0.5)" % b0.rotation)

	var v1 := poly.polygon[1]
	check("polygon 在关键帧之间插值", is_equal_approx(v1.x, 150.0), "t=0.5 时顶点 1 的 x = %f(插值 150 / 保持 100)" % v1.x)

	var rel := bezier_y_at(Vector2(0, 50), Vector2(0.5, 50), Vector2(0.9, 150), Vector2(1, 150), 0.5)
	var bx := b1.position.x
	check("贝塞尔控制柄是相对偏移 (Δ时间, Δ取值)", absf(bx - rel) < 0.01, "t=0.5 时 %f,按相对偏移算 %f" % [bx, rel])

	check("visible 离散", poly.visible == false, "t=0.5 时 %s(期望 false)" % str(poly.visible))
	check("z_index 离散", poly.z_index == 5, "t=0.5 时 %d(期望 5)" % poly.z_index)
	var m := poly.self_modulate
	check("self_modulate 线性插值", is_equal_approx(m.g, 0.5) and is_equal_approx(m.a, 0.5), "t=0.5 时 %s" % str(m))

	player.seek(0.25, true)
	check("visible 在切换点之前", poly.visible == true, "t=0.25 时 %s" % str(poly.visible))

	# 骨骼的 rest 与当前姿势是两回事
	check("Bone2D.rest 保留", b1.rest.get_rotation() > 0.5 and is_equal_approx(b1.rest.origin.x, 50.0), str(b1.rest))
	check("Polygon2D 骨骼数", poly.get_bone_count() == 2, "%d 根,第 0 根路径 %s" % [poly.get_bone_count(), str(poly.get_bone_path(0))])

	reset_semantics()
	property_names()

	for line in results:
		print(line)
	return true

## 切换动画时,新动画里没有轨道的属性回不回到初始值 —— Spine 换动画会回 setup,Unity 靠 Write Defaults。
## 看 AnimationMixer.deterministic + 一条名为 RESET 的动画能不能做到
func reset_semantics() -> void:
	for deterministic in [false, true]:
		var host := Node2D.new()
		get_root().add_child(host)
		var target := Node2D.new()
		target.name = "t"
		host.add_child(target)
		var reset := Animation.new()
		var r0 := reset.add_track(Animation.TYPE_VALUE)
		reset.track_set_path(r0, NodePath("t:rotation"))
		reset.track_insert_key(r0, 0.0, 0.25)
		var a := Animation.new()
		a.length = 1.0
		var a0 := a.add_track(Animation.TYPE_VALUE)
		a.track_set_path(a0, NodePath("t:rotation"))
		a.track_insert_key(a0, 0.0, 1.0)
		a.track_insert_key(a0, 1.0, 2.0)
		var b := Animation.new()
		b.length = 1.0
		var b0 := b.add_track(Animation.TYPE_VALUE)
		b.track_set_path(b0, NodePath("t:position:x"))
		b.track_insert_key(b0, 0.0, 5.0)
		var lib := AnimationLibrary.new()
		lib.add_animation("RESET", reset)
		lib.add_animation("a", a)
		lib.add_animation("b", b)
		var p := AnimationPlayer.new()
		host.add_child(p)
		p.add_animation_library("", lib)
		p.deterministic = deterministic
		p.play("a")
		p.seek(0.5, true)
		var in_a := target.rotation
		p.play("b")
		p.seek(0.5, true)
		check("deterministic=%s:换到没有 rotation 轨道的动画后回到 RESET 值" % str(deterministic), is_equal_approx(target.rotation, 0.25),
			"a 里 %.2f → 换到 b 后 %.2f(RESET 是 0.25)" % [in_a, target.rotation])
		host.queue_free()

func property_names() -> void:
	var names: PackedStringArray = []
	for cls in ["Bone2D", "Skeleton2D", "Polygon2D", "AnimationPlayer"]:
		var obj: Object = ClassDB.instantiate(cls)
		for prop in obj.get_property_list():
			var n: String = prop["name"]
			if (prop["usage"] & PROPERTY_USAGE_STORAGE) != 0 and (n.contains("length") or n.contains("angle") or n.contains("rest") or n.contains("callback") or n.contains("deterministic") or n.contains("autoplay") or n.contains("internal") or n.contains("skeleton") or n.contains("antialias") or n.contains("invert")):
				names.append("%s.%s=%s" % [cls, n, str(obj.get(n))])
		if obj is Node:
			(obj as Node).free()
	results.append("ℹ 可存储的属性:" + ", ".join(names))
