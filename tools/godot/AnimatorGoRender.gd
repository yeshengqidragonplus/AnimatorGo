extends SceneTree
## AnimatorGo 的 Godot 渲染工具:把场景里每条动画逐帧渲成 PNG,自己看效果,不用等人截图。
## 要渲染,**不能加 --headless**:
##
##   godot --path <工程> --script res://AnimatorGoRender.gd -- res://a.tscn [输出目录] [每条动画几帧] [皮肤]
##
## 给了皮肤就先 `$SkinPlayer.play(皮肤)` —— 和运行时换皮肤同一行代码。
##
## 输出目录默认 `user://renders`(打印出实际路径)。每帧一张 `<场景>@<动画>@<序号>.png`,另有一张 setup 姿势。
## 走真正的 AnimationPlayer(deterministic + RESET),和运行时一样:换动画时没轨道的属性回 setup。
## 相机按 setup 姿势下所有可见 Polygon2D 的范围取景,留出余量。

const SIZE := 768

var scene_path := ""
var out_dir := "user://renders"
var steps := 6
var skin := ""
var vp: SubViewport
var scene: Node
var player: AnimationPlayer
var jobs: Array[Dictionary] = []
var index := -1
var countdown := 0

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		print("用法:godot --path <工程> --script res://AnimatorGoRender.gd -- res://a.tscn [输出目录] [每条动画几帧]")
		quit(2)
		return
	scene_path = args[0]
	if args.size() > 1:
		out_dir = args[1]
	if args.size() > 2:
		steps = int(args[2])
	if args.size() > 3:
		skin = args[3]
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(out_dir))

	vp = SubViewport.new()
	vp.size = Vector2i(SIZE, SIZE)
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	get_root().add_child(vp)
	var bg := ColorRect.new()
	bg.color = Color(0.82, 0.82, 0.82)
	bg.size = Vector2(100000, 100000)
	bg.position = -bg.size / 2
	bg.z_index = -4096
	vp.add_child(bg)

	scene = (load(scene_path) as PackedScene).instantiate()
	player = scene.find_children("*", "AnimationPlayer", true, false)[0]
	# 进树之前关掉自动播放,先拍 setup 姿势
	player.autoplay = ""
	vp.add_child(scene)

func frame_camera() -> void:
	var lo := Vector2(INF, INF)
	var hi := Vector2(-INF, -INF)
	for node in scene.find_children("*", "Polygon2D", true, false):
		var poly := node as Polygon2D
		if not poly.is_visible_in_tree() or poly.get_bone_count() > 0:
			continue
		var xf := poly.get_global_transform()
		for p in poly.polygon:
			var q: Vector2 = xf * p
			lo = lo.min(q)
			hi = hi.max(q)
	# 蒙皮网格的顶点不好直接取,用骨骼位置代表它们的范围
	for node in scene.find_children("*", "Bone2D", true, false):
		var gp: Vector2 = (node as Bone2D).global_position
		lo = lo.min(gp)
		hi = hi.max(gp)
	var cam := Camera2D.new()
	cam.position = (lo + hi) / 2
	var extent := maxf(hi.x - lo.x, hi.y - lo.y) * 1.6
	cam.zoom = Vector2.ONE * (SIZE / maxf(extent, 1.0))
	vp.add_child(cam)
	cam.make_current()
	print("取景:%s → %s" % [str(lo), str(hi)])

func _process(_delta: float) -> bool:
	if index == -1:
		if skin != "":
			var sp := scene.get_node_or_null("SkinPlayer") as AnimationPlayer
			if sp == null:
				print("这个场景没有 SkinPlayer(单皮肤)")
			else:
				sp.play(skin)
				sp.seek(0, true)
		frame_camera()
		# ⚠️ 播放器定住不走:下面等两帧才截图,不定住的话截到的比要的晚约 0.05 秒(实测)。
		# 不用 pause() —— 暂停后再 play() 恢复、往回 seek,离散的 visible 轨道会取错键(实测,图整个灭掉)
		player.speed_scale = 0.0
		jobs.append({"anim": "", "t": 0.0, "i": 0})
		for anim_name in player.get_animation_list():
			if anim_name == "RESET":
				continue
			var length := player.get_animation(anim_name).length
			# 时刻与 Unity 的渲染工具(AnimatorGoRender.cs)相同,两边能逐帧对照;不取 t = 时长 —— 循环动画在那一刻绕回开头
			for i in steps:
				jobs.append({"anim": anim_name, "t": length * i / steps, "i": i})
		index = 0
		countdown = 3
		return false
	if index >= jobs.size():
		print("完成:%d 张 → %s" % [jobs.size(), ProjectSettings.globalize_path(out_dir)])
		return true
	var job := jobs[index]
	if not job.has("posed"):
		if job["anim"] != "":
			player.play(job["anim"])
			player.seek(job["t"], true)
		job["posed"] = true
		countdown = 2
		return false
	if countdown > 0:
		countdown -= 1
		return false
	var label: String = "setup" if job["anim"] == "" else "%s@%02d" % [job["anim"], job["i"]]
	if skin != "":
		label = skin + "@" + label
	var file := "%s/%s@%s.png" % [out_dir, scene_path.get_file().get_basename(), label]
	vp.get_texture().get_image().save_png(file)
	index += 1
	return false
