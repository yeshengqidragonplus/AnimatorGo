class_name AnimatorGoPlayer
extends Node2D

## 复制到 Godot 项目后，将 exported_package 指向导出的 export/godot 目录。
## 完整实现会在这里建立 Bone2D/CanvasItem 或直接用 _draw() 绘制 region attachment。

@export_dir var exported_package: String
@export var animation_name := ""
@export var playing := true

var _document: Dictionary = {}
var _time := 0.0

func _ready() -> void:
	load_package()

func load_package() -> void:
	var file := FileAccess.open(exported_package.path_join("animatorgo.json"), FileAccess.READ)
	if file == null:
		push_error("AnimatorGo: 找不到 animatorgo.json: " + exported_package)
		return
	var parsed = JSON.parse_string(file.get_as_text())
	if not (parsed is Dictionary) or parsed.get("format") != "animatorgo-runtime":
		push_error("AnimatorGo: 不支持的资源包格式")
		return
	_document = parsed.get("project", {})
	if animation_name.is_empty() and not _document.get("animations", []).is_empty():
		animation_name = _document.animations[0].get("name", "")

func _process(delta: float) -> void:
	if not playing or _document.is_empty():
		return
	# TODO: 按 AnimatorGo core/animation.ts 采样 TRS，更新世界矩阵与 slot 绘制。
	_time += delta

func play_animation(name: String) -> void:
	animation_name = name
	_time = 0.0
