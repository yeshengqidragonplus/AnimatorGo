extends SceneTree
## AnimatorGo 的 Godot 混合模式探针:渲染到 SubViewport 读像素,核对 multiply 的真实行为(docs/GODOT.md 第 13 节)。
## 要渲染,**不能加 --headless**:
##   godot --path <工程> --script res://AnimatorGoProbeBlend.gd [-- transparent]
##   godot --path <工程> --rendering-method forward_plus --script res://AnimatorGoProbeBlend.gd     # 换渲染器
##
## 背景是已知颜色,上面铺一张四个象限各一种 texel(直通 alpha)的贴图,读回每个象限的像素,
## 和 Spine 的 multiply `dst · lerp(1, src.rgb, src.a)` 比(src = texel × self_modulate × color)。

const SIZE := 256
const DST := Color(0.8, 0.6, 0.4, 1.0)
const TEXELS := [Color(0.5, 0.5, 0.5, 1.0), Color(0.5, 0.25, 1.0, 0.5), Color(1.0, 0.0, 0.0, 0.0), Color(0.0, 0.0, 0.0, 0.25)]
## 第一个与导出器写的着色器相同(src/spine-convert/godot/export.ts 的 MULTIPLY_SHADER),改了要一起改
const SHADERS := {
	"导出用的 blend_mul": "shader_type canvas_item;\nrender_mode blend_mul;\nvoid fragment() {\n\tCOLOR = vec4(mix(vec3(1.0), COLOR.rgb, COLOR.a), 1.0);\n}\n",
	"texture(TEXTURE, UV) * COLOR": "shader_type canvas_item;\nrender_mode blend_mul;\nvoid fragment() {\n\tvec4 c = texture(TEXTURE, UV) * COLOR;\n\tCOLOR = vec4(mix(vec3(1.0), c.rgb, c.a), 1.0);\n}\n",
}
## [self_modulate, color]
const TINTS := [[Color(1, 1, 1, 1), Color(1, 1, 1, 1)], [Color(1, 1, 1, 0.5), Color(1, 1, 1, 1)], [Color(1, 0.5, 1, 1), Color(1, 1, 1, 1)], [Color(1, 1, 1, 1), Color(0.5, 1, 1, 0.5)]]

var vp: SubViewport
var cases: Array[Dictionary] = []
var worst := {}
var index := 0
var countdown := 3

func _initialize() -> void:
	vp = SubViewport.new()
	vp.size = Vector2i(SIZE, SIZE)
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	vp.transparent_bg = OS.get_cmdline_user_args().has("transparent")
	get_root().add_child(vp)
	var img := Image.create(64, 64, false, Image.FORMAT_RGBA8)
	for q in 4:
		img.fill_rect(Rect2i((q % 2) * 32, (q / 2) * 32, 32, 32), TEXELS[q])
	var tex := ImageTexture.create_from_image(img)
	var materials := {}
	var mul := CanvasItemMaterial.new()
	mul.blend_mode = CanvasItemMaterial.BLEND_MODE_MUL
	materials["CanvasItemMaterial MUL"] = mul
	for label in SHADERS:
		var shader := Shader.new()
		shader.code = SHADERS[label]
		var sm := ShaderMaterial.new()
		sm.shader = shader
		materials[label] = sm
	for label in materials:
		worst[label] = 0.0
		for t in TINTS:
			cases.append({"label": label, "material": materials[label], "self_modulate": t[0], "color": t[1], "texture": tex})
	build(cases[0])

func build(c: Dictionary) -> void:
	for child in vp.get_children():
		child.queue_free()
	var bg := ColorRect.new()
	bg.color = DST
	bg.size = Vector2(SIZE, SIZE)
	vp.add_child(bg)
	var p := Polygon2D.new()
	p.texture = c["texture"]
	p.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	p.polygon = PackedVector2Array([Vector2(0, 0), Vector2(SIZE, 0), Vector2(SIZE, SIZE), Vector2(0, SIZE)])
	p.uv = PackedVector2Array([Vector2(0, 0), Vector2(64, 0), Vector2(64, 64), Vector2(0, 64)])
	p.self_modulate = c["self_modulate"]
	p.color = c["color"]
	p.material = c["material"]
	vp.add_child(p)

func spine_multiply(texel: Color, self_modulate: Color, color: Color) -> Color:
	var s := texel * self_modulate * color
	return Color(DST.r * lerpf(1, s.r, s.a), DST.g * lerpf(1, s.g, s.a), DST.b * lerpf(1, s.b, s.a), 1)

func _process(_delta: float) -> bool:
	if countdown > 0:
		countdown -= 1
		return false
	var c := cases[index]
	var img := vp.get_texture().get_image()
	var line := "%-28s self_modulate=%s color=%s |" % [c["label"], str(c["self_modulate"]), str(c["color"])]
	for q in 4:
		var got := img.get_pixel(SIZE / 4 + (q % 2) * SIZE / 2, SIZE / 4 + (q / 2) * SIZE / 2)
		var want := spine_multiply(TEXELS[q], c["self_modulate"], c["color"])
		worst[c["label"]] = maxf(worst[c["label"]], maxf(absf(got.r - want.r), maxf(absf(got.g - want.g), absf(got.b - want.b))))
		line += " (%.3f %.3f %.3f)/(%.3f %.3f %.3f)" % [got.r, got.g, got.b, want.r, want.g, want.b]
	print(line)
	index += 1
	if index < cases.size():
		build(cases[index])
		countdown = 3
		return false
	print("── 与 Spine 的 multiply 最大差(读回 / 公式,1/255 ≈ 0.004):")
	for label in worst:
		print("  %-28s %.4f" % [label, worst[label]])
	return true
