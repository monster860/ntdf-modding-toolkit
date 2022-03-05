# .glb Import/Export Format

## Custom Properties in Blender

The Binary glTF export and import for this makes use of custom properties.

To make use of them in blender, you may need to add them to objects or materials that you create yourself. To do so, go to the object or material in the properties panel, and you will find it at the bottom.

![image](https://user-images.githubusercontent.com/3681297/156867721-ba3d5d41-872f-4b73-b3c2-2946eb8e8329.png)

If you click new, a new property will be added. You can then click the gear icon to edit the custom property.

![image](https://user-images.githubusercontent.com/3681297/156867798-99fda2f9-5369-45d0-9963-0c75299ddfc3.png)

You will want to change the Type, the Property Name, and the Min and Max (if relevant). 

## Models

In order for an object in the file to display in the game, it needs to have a material assigned to it, with an integer `ntdf_mat_index` custom property. Otherwise, the object will not display unless there are no materials in the file that have this custom property, in which case every object will use material 0.

### Object Properties

| name | type | default value | description |
| -- | -- | -- | -- |
| zone_id | integer | 0 | The zone the object displays within. The game uses this to decide whether to display the object or not, based on the zone the player is standing in. Must be from 0-255. |
| render_distance | float | 10000 | The maximum distance the object will render at. |
| fade_rate | float | 0 | The distance over which the object will fade out. Used to smooth out the object disappearing as it reaches its render distance. |
| sort_order | integer | 0 | Must be between 0 and 3 inclusive. Controls the order in which the object is displayed. Relevant for transparent objects. The game sorts objects based on the index of the texture file of the material used, and this value is used for sorting objects that use the same texture file. |
| display_mask | integer | 0 | The display mask, usually a power of two, allows the game to control whether this object is displayed or not. Used for things like purple cloud funnels, broken/fixed variations of bridges, and the 8 slices of the wheel minigame. |

## Collision

### Anatomy of a collision object

Here is an example of a collision object from the game:

![image](https://user-images.githubusercontent.com/3681297/156868660-6a3646ed-7dc2-4864-b9b8-9a36f4b80e76.png)

A collision object has two parts. The first part is the floor, which is the part that you can walk on. The game stores it as a 2D height map. It is not necessary for an object to have a floor.

![image](https://user-images.githubusercontent.com/3681297/156868680-a0b745f1-46f1-4417-a9f3-8be413018428.png)

A collision object also has a boundary. The boundary is made up of perfectly vertical sections, either rectangles or parallelograms. The boundary has three purposes. It controls where the floor applies. It is a wall, preventing the player from walking through it. Finally, it is a ledge the player can climb on. All objects must have a boundary.

![image](https://user-images.githubusercontent.com/3681297/156868697-77f896f2-8dd1-478a-91b5-2cda9010dc1d.png)

### Object Properties

name | type | default value | description
--|--|--|--
collision | integer | 0 | Set to 1 to enable collision on this object
collision_mask | integer | 0 | The collision mask, usually a power of two, allows the game to control whether this object is enabled or not. Used for broken/fixed variations of bridges and some invisible walls.
drown_target | integer | -1 | When the floor type is set to Drown, this value controls where the player respawns when drowning. The default value of -1 causes a game over screen to appear.
floor_type | string | "Normal" | Controls behavior when walking on this floor. Valid values are None, Normal, Drown, and SlowWalk.
floor_material | string | "Dirt" | Controls the sounds and particle effects made when walking on this object. See [Valid floor materials](#valid-floor-materials)
water_splash_object | string | "" | When set, walking on this object causes water splashing effects to appear on the floor surface of the specified object. The player will not be able to collide with that splash object.
zone_id | number | 0 | Controls which zone the player is in when standing on this object
heightmap_resolution | number | 1.5 | Controls how much detail is stored in the floor heightmap. Smaller values have more detail, but will use more memory. Minimum values is 0.1. This value is ignored if the floor is perfectly flat.
max_slope | number | 1000 | The maximum slope of polygons that will be used as floor.
extend | number | 120 | How many feet to extend the boundary downward if generating automatically from floor polygons. Setting this value will force it to ignore wall polygons and generate automatically.

### Valid floor materials

The following floor materials are available:
- Dirt
- Grass
- Lava
- Metal
- MetalGrate
- Muck
- Stone
- Treasure
- Water
- Wood
- WoodBridge
- FastWater
- LooseRock
- Leaf
- Flower
- Pollen
- Coal
- StrawRoof
- Twigs
- Bone

Not all values produce sounds. The Lava material hurts the player when walking on it.
