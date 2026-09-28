extends SceneTree
## AnimatorGo 的 Godot 产物自检:在 Godot 里真的加载场景,查「只有 Godot 自己知道、而且不报错」的问题。
##
##   godot --headless --path <工程> --import                       # 先让 Godot 导入贴图
##   godot --headless --path <工程> --script res://AnimatorGoVerify.gd -- res://a.tscn res://b.tscn …
##
## 查的东西:
## 1. 动画轨道的节点路径 / 属性指不到东西 —— Godot 直接忽略这条轨道,表现是「某个部件就是不动」
## 2. 蒙皮 Polygon2D 的 skeleton / 骨骼路径指不到 —— 网格直接不画(探针里实测过)
## 3. 贴图没加载上
## 最后一行是 `AnimatorGo 自检:全部通过 ✅` 或 `AnimatorGo 自检:有问题 ❌`。

var problems := 0

func report(msg: String) -> void:
	problems += 1
	print("  ❌ " + msg)

func verify(path: String) -> void:
	print("── " + path)
	var packed: PackedScene = load(path)
	if packed == null:
		report("场景加载失败")
		return
	var root: Node = packed.instantiate()
	get_root().add_child(root)

	var polys := 0
	var skinned := 0
	var bones_total := 0
	for node in root.find_children("*", "Polygon2D", true, false):
		var poly := node as Polygon2D
		polys += 1
		if poly.texture == null:
			report("%s:没有贴图" % root.get_path_to(poly))
		if poly.get_bone_count() == 0:
			continue
		skinned += 1
		var skel := poly.get_node_or_null(poly.skeleton) as Skeleton2D
		if skel == null:
			report("%s:skeleton 路径 %s 指不到 Skeleton2D" % [root.get_path_to(poly), poly.skeleton])
			continue
		var weights_len := -1
		for i in poly.get_bone_count():
			bones_total += 1
			var bp := poly.get_bone_path(i)
			if skel.get_node_or_null(bp) == null:
				report("%s:骨骼路径 %s 指不到" % [root.get_path_to(poly), bp])
			var w := poly.get_bone_weights(i)
			if weights_len >= 0 and w.size() != weights_len:
				report("%s:各骨骼的权重数组长度不一" % root.get_path_to(poly))
			weights_len = w.size()
		if weights_len != poly.polygon.size():
			report("%s:权重 %d 个,顶点 %d 个" % [root.get_path_to(poly), weights_len, poly.polygon.size()])

	var tracks := 0
	var animations := 0
	for player in root.find_children("*", "AnimationPlayer", true, false):
		var ap := player as AnimationPlayer
		var base: Node = ap.get_node(ap.root_node)
		for lib_name in ap.get_animation_library_list():
			var lib := ap.get_animation_library(lib_name)
			for anim_name in lib.get_animation_list():
				var anim := lib.get_animation(anim_name)
				animations += 1
				for t in anim.get_track_count():
					tracks += 1
					var np := anim.track_get_path(t)
					var target := base.get_node_or_null(NodePath(np.get_concatenated_names()))
					if target == null:
						report("动画 %s 轨道 %d:节点 %s 不存在" % [anim_name, t, np.get_concatenated_names()])
						continue
					var prop := np.get_concatenated_subnames()
					if target.get_indexed(NodePath(prop)) == null:
						report("动画 %s 轨道 %d:%s 上没有属性 %s" % [anim_name, t, np.get_concatenated_names(), prop])

	var skels := root.find_children("*", "Skeleton2D", true, false)
	var bone_count := 0
	for s in skels:
		bone_count += (s as Skeleton2D).get_bone_count()
	print("  Polygon2D %d 个(蒙皮 %d,骨骼引用 %d),Skeleton2D 骨骼 %d 根,动画 %d 条 / 轨道 %d 条" % [polys, skinned, bones_total, bone_count, animations, tracks])
	root.queue_free()

## 要等进了场景树才能查 Skeleton2D(骨骼是进树时才登记的),所以放到第一帧做
func _process(_delta: float) -> bool:
	var scenes := OS.get_cmdline_user_args()
	if scenes.is_empty():
		print("用法:godot --headless --path <工程> --script res://AnimatorGoVerify.gd -- res://a.tscn …")
		return true
	for s in scenes:
		verify(s)
	print("AnimatorGo 自检:" + ("全部通过 ✅" if problems == 0 else "有问题 ❌(%d 处)" % problems))
	return true
