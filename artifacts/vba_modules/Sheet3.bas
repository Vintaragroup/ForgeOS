Attribute VB_Name = "Sheet3"
Attribute VB_Base = "0{00020820-0000-0000-C000-000000000046}"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
Attribute VB_TemplateDerived = False
Attribute VB_Customizable = True
'Put this procedure in your Worksheet's in the Microsoft Excel Objects folder
Private Sub Worksheet_SelectionChange(ByVal Target As Range)
    
    ' Check if Active Cell format matches the "Short Date" number format
    If ActiveCell.NumberFormat = "m/d/yyyy" Then
        ' If the Active Cell format is a date, make the calendar visible
        ActiveSheet.Shapes("Calendar").Visible = True
        
        ' Change the position of the calendar to be just below and to the right of the Active Cell
        ActiveSheet.Shapes("Calendar").Left = ActiveCell.Left + ActiveCell.Width
        ActiveSheet.Shapes("Calendar").Top = ActiveCell.Top + ActiveCell.Height
    
    ' If the Active Cell isn't a date, make the calendar invisible
    
    End If

End Sub
