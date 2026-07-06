#!/usr/bin/env python3
"""
Build runtime GLBs for Kenney "Animated Characters 1".

Run with Blender, not plain Python:

  blender --background --python scripts/build_kenney_3d_characters.py

The source FBX files remain in the local Kenney bundle. Outputs are written under
html/assets/generated/ (gitignored) for CDN/local delivery.
"""
from pathlib import Path
import bpy


ROOT = Path(__file__).resolve().parents[1]
KENNEY = Path("/home/jw/Drawings/assets/Kenney Game Assets All-in-1 1.1.0/3D assets/Animated Characters 1")
OUT = ROOT / "html/assets/generated/3d/kenney-animated-characters"

MODEL = KENNEY / "Model/characterMedium.fbx"
ANIMS = {
    "idle": KENNEY / "Animations/idle.fbx",
    "run": KENNEY / "Animations/run.fbx",
    "jump": KENNEY / "Animations/jump.fbx",
}
SKINS = {
    "survivorMaleB": KENNEY / "Skins/survivorMaleB.png",
    "survivorFemaleA": KENNEY / "Skins/survivorFemaleA.png",
}


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=str(path), automatic_bone_orientation=True)
    return [obj for obj in bpy.data.objects if obj not in before]


def find_armature(objects):
    for obj in objects:
        if obj.type == "ARMATURE":
            return obj
    return None


def assign_skin(meshes, texture_path):
    image = bpy.data.images.load(str(texture_path), check_existing=True)
    mat = bpy.data.materials.new(texture_path.stem)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if "Alpha" in tex.outputs and "Alpha" in bsdf.inputs:
        mat.node_tree.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        mat.blend_method = "BLEND"
    for mesh in meshes:
        mesh.data.materials.clear()
        mesh.data.materials.append(mat)


def append_animation(main_armature, anim_name, anim_path):
    imported = import_fbx(anim_path)
    anim_armature = find_armature(imported)
    action = anim_armature.animation_data.action if anim_armature and anim_armature.animation_data else None
    if action:
        copied = action.copy()
        copied.name = anim_name
        main_armature.animation_data_create()
        main_armature.animation_data.action = copied
        track = main_armature.animation_data.nla_tracks.new()
        track.name = anim_name
        strip = track.strips.new(anim_name, int(copied.frame_range[0]), copied)
        strip.name = anim_name
        main_armature.animation_data.action = None
    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)


def build_skin(name, texture_path):
    clear_scene()
    imported = import_fbx(MODEL)
    armature = find_armature(imported)
    if not armature:
        raise RuntimeError("No armature found in characterMedium.fbx")
    meshes = [obj for obj in imported if obj.type == "MESH"]
    assign_skin(meshes, texture_path)
    for anim_name, anim_path in ANIMS.items():
        append_animation(armature, anim_name, anim_path)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = armature

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / f"{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_nla_strips=True,
        export_force_sampling=True,
    )
    print(f"Wrote {out_path}")


def main():
    for name, skin in SKINS.items():
        build_skin(name, skin)


if __name__ == "__main__":
    main()
